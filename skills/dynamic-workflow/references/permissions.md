# Permission Model

Permission profiles are deterministic plan fields, not ad hoc prompt instructions.

- `classifier`: no write or shell access.
- `executor_writer`: write-capable current-host execution.
- `reviewer_readonly`: read-only review.
- `synthesizer`: combines artifacts and summaries.
- `research`: read/web reference work.
- `command_collector`: bounded evidence collection commands only.
- `command_verifier`: verification commands only.
- `human_approval`: pauses for user input.
