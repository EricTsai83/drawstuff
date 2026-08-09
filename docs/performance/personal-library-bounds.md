# Personal Library size bounds

- Status: Current
- Measured: 2026-08-09
- Source: refreshed `excalidraw/excalidraw-libraries` `main`
- Codec: Drawstuff `compressData` pako envelope

These measurements set the transport and storage limits for a complete personal Excalidraw Library
snapshot. The catalog fixtures are measurement inputs only; automated tests use fixed local data and
do not require third-party network availability.

## Measurements

| Fixture                                                                 | Items | Raw JSON bytes | Compressed bytes | Base64 bytes |
| ----------------------------------------------------------------------- | ----: | -------------: | ---------------: | -----------: |
| Largest current official Library (`original-google-architecture-icons`) |   139 |      2,256,341 |          556,545 |      742,060 |
| Three largest current official Libraries merged                         |   302 |      6,184,276 |        1,731,944 |    2,309,260 |
| 1,000 generated small items                                             | 1,000 |      3,385,688 |           32,248 |       43,000 |

## Approved limits

| Boundary                                         |  Limit |
| ------------------------------------------------ | -----: |
| Official `.excalidrawlib` response               |  8 MiB |
| Compressed Library envelope / PostgreSQL `bytea` |  3 MiB |
| Base64 request field                             |  4 MiB |
| Decompressed JSON                                | 10 MiB |

The 4 MiB base64 guard keeps the complete JSON request below the deployment request envelope while
allowing the measured three-Library fixture. The server verifies the decoded compressed length and
the decompressed limit independently, so base64 expansion and compression bombs cannot bypass the
storage limits. These limits are schema checks and runtime contracts; raising one requires a new
measurement and coordinated client, router, and database changes.
