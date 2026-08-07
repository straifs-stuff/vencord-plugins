import { spawn, type SpawnOptions } from "node:child_process";

interface PnpmSpawnSpec {
    command: string;
    args: string[];
}

export function pnpmSpawnSpec(
    args: string[],
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env
): PnpmSpawnSpec {
    const executable = env.STRAIF_PNPM || (platform === "win32" ? "pnpm.cmd" : "pnpm");

    if (platform !== "win32" || !/\.(?:bat|cmd)$/i.test(executable)) return { command: executable, args };

    return {
        command: env.ComSpec || env.COMSPEC || "cmd.exe",
        args: ["/d", "/s", "/c", executable, ...args]
    };
}

export function spawnPnpm(args: string[], options: SpawnOptions = {}) {
    const invocation = pnpmSpawnSpec(args);
    return spawn(invocation.command, invocation.args, options);
}
