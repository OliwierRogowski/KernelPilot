#!/usr/bin/env python3
"""Validate the provider-neutral messages dataset and summarize its diversity."""
import argparse
import json
from collections import Counter
from pathlib import Path


def validate(records):
    errors = []
    categories = Counter()
    prompts = Counter()
    answers = Counter()
    total_messages = 0
    for index, record in enumerate(records):
        label = f"record {index + 1}"
        if not isinstance(record, dict) or not isinstance(record.get("messages"), list):
            errors.append(f"{label}: expected an object with a messages array")
            continue
        messages = record["messages"]
        if len(messages) < 3 or len(messages) % 2 == 0:
            errors.append(f"{label}: expected system, user, assistant turns (optionally repeated user/assistant pairs)")
            continue
        if messages[0].get("role") != "system":
            errors.append(f"{label}: first message must have role system")
        if (len(messages) - 1) % 2:
            errors.append(f"{label}: conversation must end with an assistant message")
        for turn, message in enumerate(messages):
            total_messages += 1
            expected = "system" if turn == 0 else ("user" if turn % 2 else "assistant")
            if not isinstance(message, dict) or message.get("role") != expected or not isinstance(message.get("content"), str) or not message["content"].strip():
                errors.append(f"{label}: message {turn + 1} must be non-empty {expected} text")
                continue
            if expected == "user":
                prompts[message["content"].strip()] += 1
            elif expected == "assistant":
                answers[message["content"].strip()] += 1
        metadata = record.get("metadata")
        if not isinstance(metadata, dict) or not isinstance(metadata.get("category"), str) or not metadata["category"].strip():
            errors.append(f"{label}: metadata.category is required")
        else:
            categories[metadata["category"]] += 1
    return errors, categories, prompts, answers, total_messages


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", nargs="?", default="fine-tuning-2.json")
    parser.add_argument("--jsonl", help="write generic one-conversation-per-line JSONL; verify target trainer's template separately")
    args = parser.parse_args()
    try:
        records = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Dataset could not be read as JSON: {exc}") from exc
    if not isinstance(records, list):
        raise SystemExit("Dataset root must be a JSON array.")
    errors, categories, prompts, answers, total_messages = validate(records)
    print(f"records: {len(records)}")
    print(f"messages: {total_messages}")
    print(f"categories: {len(categories)}")
    print(f"unique user prompts: {len(prompts)} / {sum(prompts.values())}")
    print(f"unique assistant responses: {len(answers)} / {sum(answers.values())}")
    print("category coverage:")
    for category, count in sorted(categories.items()):
        print(f"  {category}: {count}")
    duplicates = sum(count - 1 for count in answers.values() if count > 1)
    print(f"repeated assistant response occurrences: {duplicates}")
    if len(records) < 20:
        errors.append("Dataset contains fewer than 20 records.")
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        raise SystemExit(1)
    if args.jsonl:
        Path(args.jsonl).write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
        print(f"generic JSONL written: {args.jsonl}")
    print("schema validation: PASS (provider-neutral messages format; not a claim of compatibility with a specific training service)")


if __name__ == "__main__":
    main()
