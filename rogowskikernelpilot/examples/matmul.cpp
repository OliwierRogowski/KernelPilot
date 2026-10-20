#include <cstddef>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {

std::size_t checkedElementCount(int rows, int columns)
{
    if (rows < 0 || columns < 0)
    {
        throw std::invalid_argument("Matrix dimensions cannot be negative");
    }

    const auto rowCount = static_cast<std::size_t>(rows);
    const auto columnCount = static_cast<std::size_t>(columns);
    if (columnCount != 0 &&
        rowCount > std::numeric_limits<std::size_t>::max() / columnCount)
    {
        throw std::length_error("Matrix dimensions are too large");
    }
    return rowCount * columnCount;
}

} // namespace

std::vector<int> matrixMultiplicationCPU(
    int rowOfMatrixA,
    int colOfMatrixA,
    int* matrixA,
    int rowOfMatrixB,
    int colOfMatrixB,
    int* matrixB)
{
    if (colOfMatrixA != rowOfMatrixB)
    {
        throw std::invalid_argument(
            "Columns of Matrix A must equal rows of Matrix B");
    }

    const std::size_t sizeA =
        checkedElementCount(rowOfMatrixA, colOfMatrixA);
    const std::size_t sizeB =
        checkedElementCount(rowOfMatrixB, colOfMatrixB);
    const std::size_t sizeC =
        checkedElementCount(rowOfMatrixA, colOfMatrixB);

    if (sizeA != 0 && matrixA == nullptr)
    {
        throw std::invalid_argument("Matrix A pointer is null");
    }
    if (sizeB != 0 && matrixB == nullptr)
    {
        throw std::invalid_argument("Matrix B pointer is null");
    }

    std::vector<int> matrixC;
    if (sizeC > matrixC.max_size())
    {
        throw std::length_error("Result matrix is too large");
    }
    matrixC.assign(sizeC, 0);

    const auto rowsA = static_cast<std::size_t>(rowOfMatrixA);
    const auto columnsA = static_cast<std::size_t>(colOfMatrixA);
    const auto columnsB = static_cast<std::size_t>(colOfMatrixB);

    for (std::size_t row = 0; row < rowsA; ++row)
    {
        for (std::size_t column = 0; column < columnsB; ++column)
        {
            long long sum = 0;
            for (std::size_t k = 0; k < columnsA; ++k)
            {
                const long long product =
                    static_cast<long long>(matrixA[row * columnsA + k]) *
                    matrixB[k * columnsB + column];

                if ((product > 0 &&
                     sum > std::numeric_limits<long long>::max() - product) ||
                    (product < 0 &&
                     sum < std::numeric_limits<long long>::min() - product))
                {
                    throw std::overflow_error(
                        "Matrix multiplication intermediate overflow");
                }
                sum += product;
            }

            if (sum < std::numeric_limits<int>::min() ||
                sum > std::numeric_limits<int>::max())
            {
                throw std::overflow_error(
                    "Matrix multiplication result does not fit in int");
            }
            matrixC[row * columnsB + column] = static_cast<int>(sum);
        }
    }

    return matrixC;
}
