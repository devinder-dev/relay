// Sends raw HTTP so duplicate Authorization headers survive the client unchanged.
import { createConnection } from "node:net";

// Step 1: wait for the server to close this one-request connection, with a test deadline.
export function rawMe(port: number, keys: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("Raw HTTP request timed out")));
    socket.on("error", reject);
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.on("connect", () => {
      socket.write([
        "GET /v1/me HTTP/1.1", "Host: localhost", "Connection: close",
        ...keys.map((key) => `Authorization: Bearer ${key}`), "", "",
      ].join("\r\n"));
    });
    socket.on("end", () => resolve(Number(response.split(" ")[1])));
  });
}
