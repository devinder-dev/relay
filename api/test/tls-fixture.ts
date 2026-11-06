// Creates a temporary local CA and leaf certificate without disabling TLS verification.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Step 1: OpenSSL extfiles work with both macOS LibreSSL and Linux OpenSSL.
export async function tlsFixture(host = "receiver.test") {
  const dir = await mkdtemp(join(tmpdir(), "relay-tls-"));
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["openssl", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`Test certificate generation failed: ${result.stderr.toString()}`);
  };
  try {
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
      "-days", "1", "-subj", "/CN=Relay test CA"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${host}`]);
    await writeFile(join(dir, "leaf.ext"), `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
    run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
      "-out", "leaf.pem", "-days", "1", "-extfile", "leaf.ext"]);
    return { ca: await readFile(join(dir, "ca.pem")), key: await readFile(join(dir, "leaf.key")),
      cert: await readFile(join(dir, "leaf.pem")), close: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
