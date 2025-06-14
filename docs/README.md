# SpaceCat Task Processor Documentation

## Introduction
SpaceCat Task Processor is a modular Node.js service that processes messages from the AWS SQS queue `SPACECAT-TASK-PROCESSOR-JOBS`. It dispatches each message to a handler based on the message's `type` field, supporting a variety of site-related automation tasks.

## Architecture Overview
- **SQS Integration:** Listens to the `SPACECAT-TASK-PROCESSOR-JOBS` queue and processes incoming messages.
- **Handler System:** Uses a mapping in `src/index.js` to route messages to the correct handler module. Handlers are located in subdirectories of `src/` (e.g., `audit-status-processor`, `demo-url-processor`, `disable-import-audit-processor`).
- **Extensibility:** New handlers can be added by creating a new directory and registering the handler in `src/index.js`.

## Main Handlers
- **audit-status-processor:** Checks and reports audit status for a site.
- **demo-url-processor:** Prepares and shares a demo URL for a site.
- **disable-import-audit-processor:** Disables specified imports and audits for a site.

## Project Structure
- `src/` - Source code and handlers
- `test/` - Test files
- `docs/` - Documentation (this file)

## For Users
- See the root `README.md` for setup, usage, and quick start instructions.

## For Developers
- See `src/README.md` for handler interface, message format, and extension guidelines.

## Additional Resources
- [npm documentation](https://docs.npmjs.com/)
- [AWS SQS documentation](https://docs.aws.amazon.com/sqs/)

---
For any questions or contributions, please refer to the repository's issue tracker or contact the maintainers.
