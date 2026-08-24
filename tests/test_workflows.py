from pathlib import Path


def test_comment_workflow_uses_supported_codex_permissions() -> None:
    workflow = Path(".github/workflows/sandman-comment.yml").read_text(encoding="utf-8")

    assert "--ignore-rules" not in workflow
    assert "codex-args: '[\"--ephemeral\"]'" in workflow

    notify = workflow.split("\n  notify:\n", maxsplit=1)[1]
    assert "permissions:\n      issues: write\n      pull-requests: write" in notify
