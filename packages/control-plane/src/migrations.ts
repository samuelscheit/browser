import { readdir, readFile } from "node:fs/promises";

/** Read SQL migrations in lexical order; each migration is applied by the PostgreSQL client. */
export async function loadPostgresMigrations(directory = new URL("../../../deploy/postgres/", import.meta.url)): Promise<string> {
  const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  if (files.length === 0) throw new Error("no Browser Fabric PostgreSQL migrations were found");
  return Promise.all(files.map((file) => readFile(new URL(file, directory), "utf8"))).then((migrations) => migrations.join("\n"));
}
