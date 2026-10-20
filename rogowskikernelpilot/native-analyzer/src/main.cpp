
#include <cstdint>
#include <functional>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "clang/AST/AST.h"
#include "clang/AST/ParentMapContext.h"
#include "clang/AST/RecursiveASTVisitor.h"
#include "clang/Frontend/CompilerInstance.h"
#include "clang/Frontend/FrontendActions.h"
#include "clang/Tooling/CommonOptionsParser.h"
#include "clang/Tooling/Tooling.h"

#include "llvm/Support/CommandLine.h"
#include "llvm/Support/Error.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/raw_ostream.h"

using namespace clang;
using namespace clang::tooling;

namespace {

llvm::cl::OptionCategory Category("KernelPilot analyzer options");

// ------------------------------------------------------------
// Dane wewnętrzne analizatora.
// Nie przechowujemy danych roboczych bezpośrednio w JSON.
// ------------------------------------------------------------

struct ConditionInfo {
    std::string type;
    unsigned line = 0;
};

struct CallInfo {
    std::string name;
    unsigned line = 0;
    bool insideLoop = false;
};

struct ParameterInfo {
    std::string name;
    std::string type;
};

struct LoopInfo {
    std::string type;
    unsigned line = 0;

    std::set<std::string> reads;
    std::set<std::string> writes;
    std::set<std::string> indexedWrites;
    std::set<std::string> indexedReads;
    std::set<std::string> inductionVariables;
    std::set<std::string> assignmentOperators;
    std::set<std::string> updateOperators;
};

struct FunctionInfo {
    std::string name;
    std::string returnType;
    unsigned line = 0;

    std::vector<ParameterInfo> parameters;
    std::vector<LoopInfo> loops;
    std::vector<ConditionInfo> conditions;
    std::vector<CallInfo> calls;
};

// ------------------------------------------------------------
// Serializacja do JSON.
// Każda metoda buduje nowy obiekt i nie odczytuje
// zagnieżdżonych wartości JSON.
// ------------------------------------------------------------

llvm::json::Object loopToJSON(const LoopInfo &loop) {
    llvm::json::Array reads;
    llvm::json::Array writes;
    llvm::json::Array assignments;
    llvm::json::Array updates;

    for (const auto &name : loop.reads)
        reads.push_back(name);

    for (const auto &name : loop.writes)
        writes.push_back(name);

    for (const auto &op : loop.assignmentOperators)
        assignments.push_back(op);

    for (const auto &op : loop.updateOperators)
        updates.push_back(op);

    llvm::json::Object result;
    result["type"] = loop.type;
    result["line"] = static_cast<int64_t>(loop.line);
    result["reads"] = std::move(reads);
    result["writes"] = std::move(writes);
    llvm::json::Array indexedReads;
    llvm::json::Array indexedWrites;
    for (const auto &name : loop.indexedReads)
        indexedReads.push_back(name);
    for (const auto &name : loop.indexedWrites)
        indexedWrites.push_back(name);
    result["indexedReads"] = std::move(indexedReads);
    result["indexedWrites"] = std::move(indexedWrites);
    result["assignmentOperators"] = std::move(assignments);
    result["updateOperators"] = std::move(updates);

    return result;
}

llvm::json::Object conditionToJSON(
    const ConditionInfo &condition) {

    llvm::json::Object result;
    result["type"] = condition.type;
    result["line"] = static_cast<int64_t>(condition.line);

    return result;
}

llvm::json::Object callToJSON(const CallInfo &call) {
    llvm::json::Object result;
    result["name"] = call.name;
    result["line"] = static_cast<int64_t>(call.line);
    result["insideLoop"] = call.insideLoop;

    return result;
}

llvm::json::Object parameterToJSON(const ParameterInfo &parameter) {
    llvm::json::Object result;
    result["name"] = parameter.name;
    result["type"] = parameter.type;
    return result;
}

llvm::json::Object functionToJSON(
    const FunctionInfo &function) {

    llvm::json::Array parameters;
    llvm::json::Array loops;
    llvm::json::Array conditions;
    llvm::json::Array calls;

    for (const auto &parameter : function.parameters)
        parameters.push_back(parameterToJSON(parameter));

    for (const auto &loop : function.loops)
        loops.push_back(loopToJSON(loop));

    for (const auto &condition : function.conditions)
        conditions.push_back(conditionToJSON(condition));

    for (const auto &call : function.calls)
        calls.push_back(callToJSON(call));

    bool hasIndexedWrite = false;
    bool hasScalarWrite = false;
    bool hasIndexedRead = false;
    bool hasLoopCall = false;
    for (const auto &loop : function.loops) {
        hasIndexedWrite |= !loop.indexedWrites.empty();
        hasIndexedRead |= !loop.indexedReads.empty();
        for (const auto &write : loop.writes)
            hasScalarWrite |= loop.indexedWrites.count(write) == 0 &&
                              loop.inductionVariables.count(write) == 0;
    }

    int score = function.loops.empty() ? 0 : 2;
    if (hasIndexedWrite) score += 3;
    if (hasIndexedRead) score += 1;
    if (hasScalarWrite) score -= 2;
    for (const auto &call : function.calls)
        hasLoopCall |= call.insideLoop;
    if (hasLoopCall) score -= 1;
    const char *rating = score >= 4 && hasIndexedWrite && !hasScalarWrite
        ? "high" : score >= 2 ? "medium" : "low";
    llvm::json::Array reasons;
    if (function.loops.empty()) reasons.push_back("No loops were found.");
    if (hasIndexedWrite) reasons.push_back("A loop writes to an indexed array element, which may map to independent GPU threads.");
    if (hasIndexedRead) reasons.push_back("A loop reads indexed array elements.");
    if (hasScalarWrite) reasons.push_back("A loop also writes scalar state; this may be a reduction or loop-carried dependency.");
    if (hasLoopCall) {
        for (const auto &call : function.calls) {
            if (call.insideLoop)
                reasons.push_back("Call to " + call.name + " occurs in a loop and may need device-compatible storage or an implementation.");
        }
    }
    if (!function.loops.empty() && !hasIndexedWrite) reasons.push_back("No indexed array writes were detected, so data-parallel work is unclear.");
    llvm::json::Object cudaAssessment;
    cudaAssessment["rating"] = rating;
    cudaAssessment["score"] = score;
    cudaAssessment["reasons"] = std::move(reasons);

    llvm::json::Object result;
    result["name"] = function.name;
    result["returnType"] = function.returnType;
    result["parameters"] = std::move(parameters);
    result["line"] = static_cast<int64_t>(function.line);
    result["loops"] = std::move(loops);
    result["conditions"] = std::move(conditions);
    result["calls"] = std::move(calls);
    result["cudaAssessment"] = std::move(cudaAssessment);

    return result;
}

// ------------------------------------------------------------
// Analiza zmiennych wewnątrz ciała pętli.
// ------------------------------------------------------------

class LoopFactsVisitor
    : public RecursiveASTVisitor<LoopFactsVisitor> {
public:
    LoopFactsVisitor(ASTContext &context, LoopInfo &loop)
        : context_(context), loop_(loop) {}

    bool VisitDeclRefExpr(DeclRefExpr *expression) {
        const auto *variable =
            dyn_cast<VarDecl>(expression->getDecl());

        if (variable == nullptr)
            return true;

        const std::string name = variable->getNameAsString();

        if (name.empty())
            return true;

        const Access access = classifyAccess(expression);

        if (access == Access::Read ||
            access == Access::ReadWrite) {
            loop_.reads.insert(name);
        }

        if (access == Access::Write ||
            access == Access::ReadWrite) {
            loop_.writes.insert(name);
        }

        return true;
    }

    bool VisitForStmt(ForStmt *statement) {
        if (const auto *declarations = dyn_cast_or_null<DeclStmt>(statement->getInit())) {
            for (const Decl *declaration : declarations->decls()) {
                if (const auto *variable = dyn_cast<VarDecl>(declaration))
                    loop_.inductionVariables.insert(variable->getNameAsString());
            }
        }
        return true;
    }

    bool VisitBinaryOperator(BinaryOperator *operation) {
        if (operation->isAssignmentOp()) {
            loop_.assignmentOperators.insert(
                operation->getOpcodeStr().str());
            std::function<void(const Stmt *)> collectWrites =
                [&](const Stmt *statement) {
                    if (const auto *subscript =
                            dyn_cast<ArraySubscriptExpr>(statement)) {
                        const Expr *base = subscript->getBase()->IgnoreParenImpCasts();
                        if (const auto *reference = dyn_cast<DeclRefExpr>(base)) {
                            const auto *variable = dyn_cast<VarDecl>(reference->getDecl());
                            if (variable != nullptr && !variable->getName().empty())
                                loop_.indexedWrites.insert(variable->getNameAsString());
                        }
                    }
                    if (const auto *memberCall =
                            dyn_cast<CXXMemberCallExpr>(statement)) {
                        const FunctionDecl *callee = memberCall->getDirectCallee();
                        if (callee != nullptr && callee->getName() == "operator[]") {
                            const Expr *object = memberCall->getImplicitObjectArgument()->IgnoreParenImpCasts();
                            if (const auto *reference = dyn_cast<DeclRefExpr>(object)) {
                                const auto *variable = dyn_cast<VarDecl>(reference->getDecl());
                                if (variable != nullptr && !variable->getName().empty())
                                    loop_.indexedWrites.insert(variable->getNameAsString());
                            }
                        }
                    }
                    if (const auto *operatorCall =
                            dyn_cast<CXXOperatorCallExpr>(statement)) {
                        if (operatorCall->getOperator() == OO_Subscript &&
                            operatorCall->getNumArgs() > 0) {
                            const Expr *object = operatorCall->getArg(0)->IgnoreParenImpCasts();
                            if (const auto *reference = dyn_cast<DeclRefExpr>(object)) {
                                const auto *variable = dyn_cast<VarDecl>(reference->getDecl());
                                if (variable != nullptr && !variable->getName().empty())
                                    loop_.indexedWrites.insert(variable->getNameAsString());
                            }
                        }
                    }
                    for (const Stmt *child : statement->children())
                        if (child != nullptr)
                            collectWrites(child);
                };
            collectWrites(operation->getLHS());
        }

        return true;
    }

    bool VisitArraySubscriptExpr(ArraySubscriptExpr *expression) {
        const Expr *base = expression->getBase()->IgnoreParenImpCasts();
        const auto *reference = dyn_cast<DeclRefExpr>(base);
        if (reference == nullptr)
            return true;
        const auto *variable = dyn_cast<VarDecl>(reference->getDecl());
        if (variable == nullptr)
            return true;
        const std::string name = variable->getNameAsString();
        if (name.empty())
            return true;

        DynTypedNode current = DynTypedNode::create(*expression);
        for (unsigned depth = 0; depth < 8; ++depth) {
            const auto parents = context_.getParents(current);
            if (parents.empty())
                break;
            if (const auto *operation = parents[0].get<BinaryOperator>()) {
                const auto *currentExpr = dyn_cast_or_null<Expr>(current.get<Stmt>());
                if (operation->isAssignmentOp() && currentExpr != nullptr &&
                    operation->getLHS()->IgnoreParenImpCasts() == currentExpr->IgnoreParenImpCasts()) {
                    loop_.indexedWrites.insert(name);
                    return true;
                }
                break;
            }
            if (parents[0].get<Expr>() == nullptr)
                break;
            current = parents[0];
        }
        loop_.indexedReads.insert(name);
        return true;
    }

    bool VisitUnaryOperator(UnaryOperator *operation) {
        if (operation->isIncrementDecrementOp()) {
            loop_.updateOperators.insert(
                UnaryOperator::getOpcodeStr(
                    operation->getOpcode()).str());
        }

        return true;
    }

private:
    enum class Access {
        Read,
        Write,
        ReadWrite
    };

    ASTContext &context_;
    LoopInfo &loop_;

    Access classifyAccess(
        const DeclRefExpr *reference) const {

        DynTypedNode current =
            DynTypedNode::create(*reference);

        for (unsigned depth = 0; depth < 16; ++depth) {
            const auto parents = context_.getParents(current);

            if (parents.empty())
                break;

            const DynTypedNode &parent = parents[0];

            const auto *currentStmt = current.get<Stmt>();
            const auto *currentExpr =
                dyn_cast_or_null<Expr>(currentStmt);

            if (const auto *unary =
                    parent.get<UnaryOperator>()) {

                if (unary->isIncrementDecrementOp())
                    return Access::ReadWrite;

                return Access::Read;
            }

            // An array index expression (for example `i` in `out[i] = value`)
            // is read by the access; it is not itself assigned by the store.
            if (parent.get<ArraySubscriptExpr>() != nullptr)
                return Access::Read;

            if (const auto *binary =
                    parent.get<BinaryOperator>()) {

                if (currentExpr != nullptr) {
                    const Expr *lhs =
                        binary->getLHS()->IgnoreParenImpCasts();

                    const Expr *currentExpression =
                        currentExpr->IgnoreParenImpCasts();

                    if (lhs == currentExpression) {
                        if (binary->isCompoundAssignmentOp())
                            return Access::ReadWrite;

                        if (binary->isAssignmentOp())
                            return Access::Write;
                    }
                }

                return Access::Read;
            }

            if (parent.get<CallExpr>() != nullptr)
                return Access::Read;

            current = parent;
        }

        return Access::Read;
    }
};

// ------------------------------------------------------------
// Główny visitor Clang AST.
// ------------------------------------------------------------

class KernelPilotVisitor
    : public RecursiveASTVisitor<KernelPilotVisitor> {
public:
    explicit KernelPilotVisitor(ASTContext &context)
        : context_(context) {}

    bool VisitFunctionDecl(FunctionDecl *function) {
        const SourceManager &sm = context_.getSourceManager();

        if (!function->doesThisDeclarationHaveABody())
            return true;

        if (!sm.isWrittenInMainFile(function->getLocation()))
            return true;

        FunctionInfo info;
        info.name = function->getNameAsString();
        info.returnType = function->getReturnType().getAsString();
        for (const ParmVarDecl *parameter : function->parameters()) {
            ParameterInfo parameterInfo;
            parameterInfo.name = parameter->getNameAsString();
            parameterInfo.type = parameter->getType().getAsString();
            info.parameters.push_back(std::move(parameterInfo));
        }

        const PresumedLoc location =
            sm.getPresumedLoc(function->getLocation());

        if (location.isValid())
            info.line = location.getLine();

        functions_.push_back(std::move(info));
        functionDecls_.push_back(function);

        return true;
    }

    bool VisitForStmt(ForStmt *statement) {
        reportLoop("FOR", statement->getForLoc(),
                   statement->getBody());
        return true;
    }

    bool VisitWhileStmt(WhileStmt *statement) {
        reportLoop("WHILE", statement->getWhileLoc(),
                   statement->getBody());
        return true;
    }

    bool VisitDoStmt(DoStmt *statement) {
        reportLoop("DO_WHILE", statement->getDoLoc(),
                   statement->getBody());
        return true;
    }

    bool VisitCXXForRangeStmt(CXXForRangeStmt *statement) {
        reportLoop("RANGE_FOR", statement->getForLoc(),
                   statement->getBody());
        return true;
    }

    bool VisitIfStmt(IfStmt *statement) {
        reportCondition("IF", statement->getIfLoc());
        return true;
    }

    bool VisitSwitchStmt(SwitchStmt *statement) {
        reportCondition("SWITCH", statement->getSwitchLoc());
        return true;
    }

    bool VisitCallExpr(CallExpr *call) {
        const SourceManager &sm = context_.getSourceManager();

        if (!sm.isWrittenInMainFile(call->getExprLoc()))
            return true;

        const int index = findFunctionIndex(call->getExprLoc());

        if (index < 0)
            return true;

        CallInfo info;

        const FunctionDecl *callee = call->getDirectCallee();

        if (callee != nullptr)
            info.name = callee->getNameAsString();
        else
            info.name = "indirect_or_unknown";
        info.insideLoop = isInsideLoop(call);

        const PresumedLoc location =
            sm.getPresumedLoc(call->getExprLoc());

        if (location.isValid())
            info.line = location.getLine();

        functions_[static_cast<size_t>(index)]
            .calls.push_back(std::move(info));

        return true;
    }

    llvm::json::Array toJSON() const {
        llvm::json::Array result;

        for (const auto &function : functions_)
            result.push_back(functionToJSON(function));

        return result;
    }

private:
    ASTContext &context_;

    std::vector<FunctionInfo> functions_;
    std::vector<const FunctionDecl *> functionDecls_;

    bool isInsideLoop(const Stmt *statement) const {
        DynTypedNode current = DynTypedNode::create(*statement);
        for (unsigned depth = 0; depth < 64; ++depth) {
            const auto parents = context_.getParents(current);
            if (parents.empty())
                return false;
            const DynTypedNode &parent = parents[0];
            if (parent.get<ForStmt>() != nullptr ||
                parent.get<WhileStmt>() != nullptr ||
                parent.get<DoStmt>() != nullptr ||
                parent.get<CXXForRangeStmt>() != nullptr)
                return true;
            current = parent;
        }
        return false;
    }

    int findFunctionIndex(SourceLocation location) const {
        const SourceManager &sm = context_.getSourceManager();

        const SourceLocation expanded =
            sm.getExpansionLoc(location);

        if (expanded.isInvalid())
            return -1;

        const FileID targetFile = sm.getFileID(expanded);
        const unsigned offset = sm.getFileOffset(expanded);

        int bestIndex = -1;
        unsigned bestBegin = 0;

        for (size_t i = 0; i < functionDecls_.size(); ++i) {
            const FunctionDecl *function = functionDecls_[i];

            const SourceLocation beginLocation =
                sm.getExpansionLoc(function->getBeginLoc());

            const SourceLocation endLocation =
                sm.getExpansionLoc(function->getEndLoc());

            if (beginLocation.isInvalid() ||
                endLocation.isInvalid()) {
                continue;
            }

            if (sm.getFileID(beginLocation) != targetFile ||
                sm.getFileID(endLocation) != targetFile) {
                continue;
            }

            const unsigned begin =
                sm.getFileOffset(beginLocation);

            const unsigned end =
                sm.getFileOffset(endLocation);

            if (offset >= begin &&
                offset <= end &&
                (bestIndex < 0 || begin >= bestBegin)) {
                bestIndex = static_cast<int>(i);
                bestBegin = begin;
            }
        }

        return bestIndex;
    }

    void reportLoop(
        const char *kind,
        SourceLocation location,
        Stmt *body) {

        const SourceManager &sm = context_.getSourceManager();

        if (!sm.isWrittenInMainFile(location))
            return;

        const int index = findFunctionIndex(location);

        if (index < 0)
            return;

        LoopInfo loop;
        loop.type = kind;

        const PresumedLoc presumed =
            sm.getPresumedLoc(location);

        if (presumed.isValid())
            loop.line = presumed.getLine();

        LoopFactsVisitor factsVisitor(context_, loop);
        factsVisitor.TraverseStmt(body);

        functions_[static_cast<size_t>(index)]
            .loops.push_back(std::move(loop));
    }

    void reportCondition(
        const char *kind,
        SourceLocation location) {

        const SourceManager &sm = context_.getSourceManager();

        if (!sm.isWrittenInMainFile(location))
            return;

        const int index = findFunctionIndex(location);

        if (index < 0)
            return;

        ConditionInfo condition;
        condition.type = kind;

        const PresumedLoc presumed =
            sm.getPresumedLoc(location);

        if (presumed.isValid())
            condition.line = presumed.getLine();

        functions_[static_cast<size_t>(index)]
            .conditions.push_back(std::move(condition));
    }
};

// ------------------------------------------------------------
// AST consumer: po analizie tworzy pojedynczy dokument JSON.
// ------------------------------------------------------------

class KernelPilotConsumer : public ASTConsumer {
public:
    explicit KernelPilotConsumer(ASTContext &context)
        : context_(context), visitor_(context) {}

    void HandleTranslationUnit(ASTContext &context) override {
        visitor_.TraverseDecl(context.getTranslationUnitDecl());

        llvm::json::Object root;

        const SourceManager &sm = context_.getSourceManager();

        root["file"] =
            sm.getFilename(sm.getLocForStartOfFile(sm.getMainFileID())).str();

        root["functions"] = visitor_.toJSON();

        llvm::outs() << llvm::json::Value(std::move(root)) << '\n';
    }

private:
    ASTContext &context_;
    KernelPilotVisitor visitor_;
};

// ------------------------------------------------------------
// Frontend action.
// ------------------------------------------------------------

class KernelPilotAction : public ASTFrontendAction {
public:
    std::unique_ptr<ASTConsumer> CreateASTConsumer(
        CompilerInstance &compiler,
        llvm::StringRef) override {

        return std::make_unique<KernelPilotConsumer>(
            compiler.getASTContext());
    }
};

} // namespace

int main(int argc, const char **argv) {
    auto parserExpected =
        CommonOptionsParser::create(argc, argv, Category);

    if (!parserExpected) {
        llvm::errs()
            << llvm::toString(parserExpected.takeError())
            << '\n';

        return 1;
    }

    CommonOptionsParser &optionsParser = *parserExpected;

    ClangTool tool(
        optionsParser.getCompilations(),
        optionsParser.getSourcePathList());

    auto actionFactory =
        newFrontendActionFactory<KernelPilotAction>();

    return tool.run(actionFactory.get());
}

