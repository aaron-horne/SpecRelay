# Threat Model

The current milestone assumes every imported document, MCP argument, browser request, DNS answer, credential value, and upstream response is hostile. It permits one narrow outbound path for explicitly approved HTTPS `GET` operations, optionally using a declared API-key or HTTP Bearer credential.

| Threat | Asset | Attack surface | Impact | Mitigation | Residual risk |
|---|---|---|---|---|---|
| Malicious OpenAPI specification | Service availability and catalog integrity | Paste/upload import | DoS, stored hostile content | Byte/depth/node limits, safe YAML schema, validation, text-only UI | Parser-library defects |
| Malicious API server | Execution environment | Stored server URL and response | SSRF, redirect abuse, hostile responses | HTTPS-only broker, public-IP checks, pinned DNS, no redirects, bounded response | Public upstream can still return deceptive bounded content |
| Prompt-injected MCP client | Policy integrity | Tool names and arguments | Policy or destination bypass | Stored destination/method, declared path/query arguments only, policy re-check | Approved upstream semantics may still be unsafe |
| Compromised upstream API | Returned tool data | Bounded outbound response | Injection or misleading data | Header allowlist, byte/time limits, response treated as untrusted tool output | Caller must not treat output as trusted instructions |
| Credential theft | API credentials | Credential create/replace, database, execution transport | Account compromise | AES-GCM encrypted storage; owner-only mutation; workspace/API/destination binding; execution-time injection; no secret redisplay; redaction from logs/audits/responses | Key rotation and upstream credential compromise |
| Credential-encryption misconfiguration | Stored credential ciphertext | Startup configuration and key rotation | Credential loss or disclosure | Production requires a dedicated 32-byte base64 `CREDENTIAL_ENCRYPTION_KEY`; explicit current/previous IDs and versions; previous-key decrypt plus current-key re-encryption; no key material exposure; `SESSION_SECRET` fallback limited to development/test | Operator error during rotation or loss of both configured keys |
| Spec replacement during execution | Approved operation and destination | Import/replacement concurrent with MCP dispatch | Execution of stale or unintended specification | Database-backed lease binds workspace, API source, active specification version, and operation; shared session locks fence full dispatch against exclusive replacement locks across instances; database-enforced active marker; completion/failure/timeout release; stale/unleaseable work fails closed | Database outage or advisory-lock implementation defects |
| SSRF | Internal network and metadata services | Stored servers, arguments, redirects | Infrastructure compromise | Remote `$ref` blocked; no arbitrary URL input; protected IPs and redirects blocked | URL parser, resolver, or IP-range defects |
| DNS rebinding | Internal network | Host resolution | SSRF after validation | Two consistent resolutions required; validated address pinned to TLS request | Resolver/platform behavior |
| Cross-tenant access | Workspace data | Path IDs and DB queries | Confidentiality breach | Workspace predicate in every tenant query; isolation tests | Missing predicate in new code |
| Destructive API execution | Upstream data | Approved operation | Irreversible change | GET-only execution, no body, default deny, explicit approval | Unsafe upstreams may mutate state on GET |
| OAuth/token misbinding | Credential scheme metadata | Imported security schemes and credential selection | Credential used for wrong host or scheme | OAuth/OAuth2/OIDC absent; exact OpenAPI scheme matching; destination-bound credentials | Provider implementation defects |
| Log credential leakage | Secrets and request data | HTTP/application logs, MCP/API responses, audit events | Secret disclosure | Header redaction, managed query removal, no request-body logging, safe errors and metadata-only responses | Developer-added logs |
| XSS through documentation | Browser session | Summary/description/tags | Script execution | React text rendering only; no raw HTML/Markdown rendering | Future rich-text features |
| Complex-specification DoS | Availability | Parser and traversal | CPU/memory exhaustion | Pre-parse byte limit, depth/node limits, aliases blocked | Parsing cost below limit |
| Dependency compromise | Build and runtime | npm packages | Arbitrary code execution | Lockfile, release-age policy, minimal dependencies, audits | Maintainer compromise/typosquatting |

## Trust boundaries

1. Browser to API server: generated schemas validate all path and body input.
2. API server to application services: services receive explicit workspace context.
3. OpenAPI adapter: documents remain untrusted data and cannot initiate I/O.
4. Database: ownership filtering happens in SQL, not after global reads.
5. Network: only `OutboundRequestBroker` may cross the outbound boundary.
6. Credentials: owner-configured API-key/Bearer secrets are encrypted, bound to workspace/API/destination, and injected only after all execution checks; unsupported schemes remain rejected.
7. MCP: discovery and invocation independently enforce workspace membership and stored approval.
8. Execution leasing: the database is the coordination boundary for dispatch and specification replacement across server instances; a lease is valid only for its exact workspace, API source, specification version, and operation.

TypeSafe is development guidance only, and Jev is not a runtime dependency.
There is no semantic provider in the current trust boundary. Any future
provider must be optional, BYOK, disabled by default, advisory, and unable to
override stored approval, policy, tenancy, or outbound-request controls.