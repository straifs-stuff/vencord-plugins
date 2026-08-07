import { spawn } from "node:child_process";
export function pnpmSpawnSpec(args, platform = process.platform, env = process.env) {
    const executable = env.STRAIF_PNPM || (platform === "win32" ? "pnpm.cmd" : "pnpm");
    if (platform !== "win32" || !/\.(?:bat|cmd)$/i.test(executable))
        return { command: executable, args };
    return {
        command: env.ComSpec || env.COMSPEC || "cmd.exe",
        args: ["/d", "/s", "/c", executable, ...args]
    };
}
export function spawnPnpm(args, options = {}) {
    const invocation = pnpmSpawnSpec(args);
    return spawn(invocation.command, invocation.args, options);
}
