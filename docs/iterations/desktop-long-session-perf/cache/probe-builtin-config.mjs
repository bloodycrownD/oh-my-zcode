import { readFile } from "node:fs/promises";

const filePath = "D:/Dev/Js/oh-my-zcode/omz/config/provider/zcode-builtin.json";
try {
  const raw = await readFile(filePath, "utf8");
  const json = JSON.parse(raw);
  console.log("json ok, top keys:", Object.keys(json).slice(0, 10).join(","));
  const { decodeZCodeBuiltinRelease } = await import(
    "file:///D:/Dev/Js/oh-my-zcode/omz/packages/provider-node/src/zcode-builtin-release.ts"
  );
  try {
    const release = decodeZCodeBuiltinRelease(json);
    console.log("decode ok, revision:", release.revision);
  } catch (error) {
    console.log("DECODE FAILED:", error.constructor.name, error.message?.slice(0, 800));
  }
} catch (error) {
  console.log("READ/PARSE FAILED:", error.message);
}
process.exit(0);
