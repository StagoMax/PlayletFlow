// Development bridge: decrypt one OpenTopia Desktop key in memory and pass it
// to this server process. Never writes or prints the credential.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const providerId = process.argv.find((arg) => arg.startsWith("--provider="))?.slice(11);
const smoke = process.argv.includes("--smoke");
const syncVercelProduction = process.argv.includes("--sync-vercel-production");
const userData = process.env.OPENTOPIA_DEV_USER_DATA ||
  path.join(app.getPath("appData"), "OpenTopia Dev");
app.setName("OpenTopia Dev");
app.setPath("userData", path.resolve(userData));
if (!providerId) {
  console.error("Pass --provider=<OpenTopia provider id>");
  app.quit();
} else {
  app.whenReady().then(() => {
    const secrets = JSON.parse(fs.readFileSync(path.join(userData, "secrets.json"), "utf8"));
    const entry = secrets.secrets?.[`provider-api-key:${providerId}`];
    if (!entry?.encryptedHex || !entry.envTarget || !safeStorage.isEncryptionAvailable()) {
      throw new Error("The selected OpenTopia Desktop provider key is unavailable");
    }
    const key = safeStorage.decryptString(Buffer.from(entry.encryptedHex, "hex"));
    if (syncVercelProduction) {
      const windows = process.platform === "win32";
      const command = windows ? (process.env.ComSpec || "cmd.exe") : "vercel";
      const args = windows
        ? [
            "/d", "/s", "/c",
            "vercel.cmd env update OPENTOPIA_API_KEY production --type secret --yes",
          ]
        : [
            "env", "update", "OPENTOPIA_API_KEY", "production",
            "--type", "secret", "--yes",
          ];
      const child = spawn(command, args, {
        cwd: path.resolve(__dirname, ".."),
        stdio: ["pipe", "inherit", "inherit"],
        windowsHide: true,
      });
      child.stdin.end(`${key}\n`);
      child.on("error", (error) => {
        console.error(error.message);
        app.exit(1);
      });
      child.on("exit", (code) => app.exit(code || 0));
      return;
    }
    const server = path.resolve(__dirname, "../server");
    const opentopiaDatabase = process.env.VIDEOFLOW_OPENTOPIA_DB ||
      path.resolve(__dirname, "../../OpenTopia/.opentopia/opentopia.db");
    const child = spawn("cargo", ["run", "--manifest-path", path.join(server, "Cargo.toml"), "--", ...(smoke ? ["--smoke"] : [])], {
      cwd: server,
      stdio: "inherit",
      env: {
        ...process.env,
        [entry.envTarget]: key,
        VIDEOFLOW_OPENTOPIA_DB: opentopiaDatabase,
        VIDEOFLOW_PROVIDER_ID: providerId,
      },
    });
    child.on("error", (error) => {
      console.error(error.message);
      app.exit(1);
    });
    child.on("exit", (code) => app.exit(code || 0));
  }).catch((error) => {
    console.error(error.message);
    app.exit(1);
  });
}
