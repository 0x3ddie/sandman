# Sandman review rules

- Treat sandbox isolation, secret handling, repository checkout, and command execution as security boundaries.
- Require every revision to resolve to an explicit commit before its result can be considered evidence.
- Never allow a failed or incomplete lane to produce a verified verdict.
- Do not accept raw credentials, authorization headers, cookies, or production database connections in probe payloads.
- Require tests for every new verdict pattern and every external API error path.
- Keep Modal and GitHub side effects opt-in and visible to the caller.

