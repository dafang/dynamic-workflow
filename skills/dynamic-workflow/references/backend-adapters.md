# Backend Adapters

The MVP supports only `current`.

Omitted backend and `backend: current` execute through whichever host agent installed or invoked the skill. This does not grant permissions beyond the host session. Explicit `codex`, `claude`, `acp`, or remote backend names fail closed as deferred adapter work.

The JS harness bridge also compiles into this boundary. Harness code can choose workflow structure, but it cannot grant filesystem, shell, environment, network, or external backend access.
