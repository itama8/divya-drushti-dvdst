import { resolveSessions, type SourceSelection } from "../pi/resolve-sessions.js";
import { readSessionSnapshot } from "../store/read-session.js";
import { loadSessionFile } from "../analysis/session.js";
import { integerOption } from "../analysis/read-call.js";
import { queryInspection, validateInspectionOptions, type InspectionKind, type InspectionQueryOptions } from "../analysis/inspection.js";
import { INSPECTION_SCHEMAS } from "../analysis/inspection-schema.js";
import { emitQuery, queryFields, queryFormat } from "./query-output.js";

type Values = Record<string, string | boolean | undefined>;
export async function inspection(kind: InspectionKind, specs: string[], values: Values) {
  const string = (key: string) => typeof values[key] === "string" ? values[key] as string : undefined;
  const format = queryFormat(string("format"), values.page === true);
  const fields = queryFields(INSPECTION_SCHEMAS[kind], string("fields"));
  const offset = integerOption(string("offset") ?? "0", "--offset", 0)!;
  const limit = integerOption(string("limit") ?? "20", "--limit", 1)!;
  const textLimit = integerOption(string("text-limit") ?? "240", "--text-limit", 1, 4096)!;
  const filters: InspectionQueryOptions = {};
  for (const key of ["path", "class", "name", "operation", "basis", "outcome"] as const) if (string(key) !== undefined) Object.assign(filters, { [key]: string(key) });
  if (kind === "skills") {
    if (string("load-status") !== undefined) filters.loadStatus = string("load-status") as NonNullable<InspectionQueryOptions["loadStatus"]>;
    filters.view = (string("view") ?? "invocations") as NonNullable<InspectionQueryOptions["view"]>;
  }
  validateInspectionOptions(kind, { ...filters, offset, limit, textLimit });
  const stored = values.store !== undefined || values.session !== undefined || values.snapshot !== undefined;
  let paths: string[];
  let snapshot: string | null = null;
  if (stored) {
    if (specs.length > 0 || ["source", "root", "project", "since", "last"].some(key => values[key] !== undefined)) throw new Error("Stored selection cannot combine with transcript selectors or discovery options.");
    if (!string("store") || !string("session")) throw new Error("Stored selection requires --store and --session; --snapshot is optional.");
    const selected = await readSessionSnapshot({ store: string("store")!, sessionId: string("session")!, ...(string("snapshot") === undefined ? {} : { sourceHash: string("snapshot")! }) });
    paths = [selected.rawPath];
    snapshot = selected.sourceHash;
  } else paths = await resolveSessions({ specs,
    ...(string("source") === undefined ? {} : { source: string("source") as SourceSelection }),
    ...(string("root") === undefined ? {} : { root: string("root")! }),
    ...(string("project") === undefined ? {} : { project: string("project")! }),
    ...(string("since") === undefined ? {} : { since: string("since")! }),
    ...(string("last") === undefined ? {} : { last: integerOption(string("last"), "--last", 1)! }),
  });
  await emitQuery({ paths, fields, format, page: values.page === true, offset, limit, metadata: { selectionMode: stored ? "store" : "transcript", snapshot },
    read: async (path, offset, limit) => {
      const session = await loadSessionFile(path, { full: true });
      if (snapshot !== null && session.fingerprint !== snapshot) throw new Error("Stored raw snapshot fingerprint does not match selected hash.");
      return queryInspection(session, kind, { ...filters, offset, limit, textLimit });
    },
  });
}
