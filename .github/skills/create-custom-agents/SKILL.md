---
name: create-custom-agents
description: 'Use when deciding whether to create a VS Code custom agent or when designing one. Create agents only when they provide a clear, reusable benefit such as context isolation, distinct tool restrictions, or a repeatable specialized role.'
argument-hint: 'Describe the recurring task or agent role'
---

# Create Custom Agents

Use this checklist to decide whether a custom agent is worthwhile and, when it is, define the smallest useful agent configuration.

## Checklist

1. **Check for a real need.** Create an agent when a task recurs and benefits from a specialized role, isolated context, or different tool permissions. Do not create one for a one-off task, a simple task the current agent can handle, or a workflow better expressed as a prompt or skill.
2. **Define the job.** State the agent's purpose, expected input, concrete output, and completion criteria in a few sentences. Keep its responsibilities narrow.
3. **Set boundaries.** Specify which files or systems it may change, whether it is read-only, and any required validation. Grant only the tools and permissions needed for its job.
4. **Choose the project location.** Add workspace agents under `.github/agents/<agent-name>.agent.md`. Use a lowercase, descriptive filename and matching `name` in YAML frontmatter.
5. **Write discoverable metadata.** Provide a concise `description` with the tasks and trigger phrases that should select the agent. Include only frontmatter fields needed to define its role and tool access.
6. **Validate the design.** Check YAML syntax, confirm the description makes the intended use clear, and try a representative task. Verify that the agent stays within scope and returns the expected output; revise or remove it if it adds no meaningful value.

## Decision Rule

If the benefit is not concrete and repeatable, do not create a custom agent. Continue with the current agent or use a focused prompt or skill instead.