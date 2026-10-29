# 开发用旧课程内容转换（现有 T24 实现）

按 [ADR-0008](../../docs/adr/0008-product-development-boundary.md)，旧版迁入仅用于开发期间临时复用既有课程，工具已独立归入 `tools/desktop/`，不随正式应用交付。命令与完整个人迁入入口见[开发工具说明](../../tools/desktop/README.md)。已有桌面课程的资源读取、历史和备份保留在正常课程模块。

This converter produces a **content candidate**, not a complete personal migration
or an authority switch. T25 owns personal state, tasks, drafts, conversations,
retained history and the final single-authority handoff. It never constructs the
legacy Python `CourseService` and never replays old receipts over current JSON.

From the repository root, after installing desktop dependencies:

```sh
node tools/desktop/build.mjs
node artifacts/desktop-development/cli.cjs snapshot '{"sourceDirectory":"/path/to/stopped-legacy","directory":"/new/stopped-copy"}'
node artifacts/desktop-development/cli.cjs convert '{"sourceDirectory":"/new/stopped-copy","directory":"/new/content-candidate"}'
node tools/desktop/verify-conversion.mjs verify /new/content-candidate
```

Use a **new** directory for both steps. Normally close the old service first;
leave it closed until the consistent copy is complete. The snapshot adapter uses
Python 3's stdlib on macOS/POSIX to acquire the legacy service/content `flock`s and
SQLite rollback/WAL writer byte locks. It opens existing lock files without
creating source files. Missing locks, active service/content/SQLite writers and
symlinks reject. The locks stay acquired through the operation; there is no
reusable “stopped” flag. Other noncooperating file writers are additionally caught
by source byte hashes before publication. The application must not resume writes
to this copy during conversion. Windows migration is not implemented or claimed.

`snapshot` copies the course files, preserving existing derived artifacts without
regeneration, and backs up the read-only legacy SQLite connection into the copy.
The backup includes committed WAL changes. Runtime/cache/lock files are excluded;
the copy receives fresh empty service/content locks. Original state data stays
in this stopped copy for T25, **not** in the content candidate. `stopped-copy.json`
is a provenance/inventory record, not a future lock lease.

`DevelopmentCourseService.migration` runs in the independent development Worker.
The formal application has no migration panel, IPC or conversion capability.
`content({sessionId})` reads retained manifest, knowledge, layout and report only
in the tool. The formal `CourseService.resources.read` resolves registered image
identities and verifies bytes; the normal source registry/PDF.js protocol reads
fixed PDFs including original `VER-*` identities. Core `readUnit` reads converted
units from persisted SQLite, without falling back to static samples.

Conversion preserves the complete root knowledge document, including every theme,
unit, question record, mapping, relation, route group, coverage record, rating,
classification, rejection/retirement record, provenance and unknown field. Every
unit's full recursive reading body is persisted unchanged, including undisclosed
materials, answer nature, references, diagrams, tables and experiment payloads.
The only unit projection adds the existing renderer's `theme: {id,name}` shape;
the original fields remain in `legacy-content`. Graph route-group membership is
projected from the existing relation IDs; no relationship or rating is inferred.
The counts distinguish all question records from answerable leaf identities.

Resources use relative `resources/<sha256>` references. Registered source versions
are hash checked and copied verbatim; existing image files are decoded and copied.
Legacy `/source-pages/SRC/VER/PAGE.png` identities represent *rendered original PDF
pages*, so the converter materializes those pages using the existing local PDF.js
and canvas renderer, and registers the actual PNG hash. It does not extract or
regenerate knowledge. Existing diagram configs and unknown payloads remain intact.
All seven existing interactive blocks use the current bounded built-in renderer;
the original 8:1 MUX is now supported (11 declared input bits, independently tested
across all 2,048 rows). This is not arbitrary experiment support.

All candidate units, source registrations and original metadata commit in one FULL
SQLite transaction, after durable resource publication to a private staging tree.
The converter verifies persisted units and every copied resource, rechecks source
hashes, fsyncs the completion marker and directory, then renames the new tree into
place. Failure rolls back and removes its staging tree; it never overwrites an
existing destination. A killed process can leave a `.converting-*` directory;
it is **not** a completed course or authority. Only the final destination and its
`content-candidate.json` are published. Opening an old-format directory directly
is refused; a candidate missing its completion marker is refused.

`content-candidate.json` and `migration.content` report hashes, original source
location, counts, per-unit hashes, resource manifest, projection differences and
metadata gaps. Missing original import timestamps remain empty, not “today”. PDF
page boundaries use actual PDF page counts while old page metadata remains in the
original payload and differences are reported. Printed-page mappings are not
invented from old page labels. Course package identity and content identity/title
remain distinct. No personal history, acquisition timestamp or source verification
is fabricated by conversion.

Tests use generated PDFs and temporary courses. `migration.test.ts` exercises
actual Worker/SQLite/resource I/O, stopped locks, a consistent state snapshot,
registration rollback, corruption, reopen and independent paths. `migration.spec.ts`
executes Electron offline with generated fixtures; an explicit
`YIZHI_CONTENT_CANDIDATE` enables private current-corpus acceptance. Actual corpus,
PDFs, database, screenshots and evidence belong outside Git. These tests do not
claim full personal migration, final authority switch, physical IME/trackpad,
Windows, installer, hosted CI or release acceptance.
