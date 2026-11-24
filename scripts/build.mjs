import { build } from "esbuild";
import { mkdir, copyFile, readFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const license = await readFile("LICENSE", "utf8");
const notices = await readFile("THIRD-PARTY-NOTICES.md", "utf8");
await build({
  banner: { js: "/*!\n" + license + "\n" + notices + "\n*/" },
  entryPoints: ["src/main.js"],
  outfile: "dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian", "electron"],
  loader: { ".ego": "text" },
  legalComments: "inline",
});
for (const file of ["manifest.json", "styles.css"])
  await copyFile(file, "dist/" + file);
