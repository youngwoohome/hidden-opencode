export namespace NetworkSafety {
  /**
   * Extract likely network targets (hosts) from common CLI patterns.
   * This is intentionally conservative and best-effort.
   */
  export function hostsFromArgs(command: string, args: string[]): string[] {
    const tool = (command || "").toLowerCase()
    const hosts = new Set<string>()

    const addUrl = (value: string) => {
      try {
        if (!value) return
        if (!value.startsWith("http://") && !value.startsWith("https://")) return
        const u = new URL(value)
        if (u.host) hosts.add(u.host)
      } catch {
        // ignore
      }
    }

    const addSshLike = (value: string) => {
      // user@host, host, user@host:dest, host:dest
      if (!value) return
      if (value.startsWith("-")) return
      // strip scp dest/path
      const beforeColon = value.includes(":") ? value.split(":")[0] : value
      // strip user@
      const host = beforeColon.includes("@") ? beforeColon.split("@").at(-1)! : beforeColon
      // ignore obvious local paths
      if (!host || host.includes("/") || host.includes("\\") || host === ".") return
      // very naive host validation
      if (/^[a-z0-9.-]+$/i.test(host)) hosts.add(host)
    }

    if (tool === "curl" || tool === "wget") {
      for (const a of args) addUrl(a)
      return Array.from(hosts)
    }

    if (tool === "ssh" || tool === "scp" || tool === "sftp" || tool === "rsync") {
      for (const a of args) addSshLike(a)
      return Array.from(hosts)
    }

    // netcat / telnet: first non-flag arg is usually host
    if (tool === "nc" || tool === "netcat" || tool === "telnet") {
      const first = args.find((a) => a && !a.startsWith("-"))
      if (first) addSshLike(first)
      return Array.from(hosts)
    }

    return []
  }
}

