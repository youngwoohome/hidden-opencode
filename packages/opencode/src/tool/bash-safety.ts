export namespace BashSafety {
  /**
   * Very conservative heuristics to detect potentially destructive shell commands.
   * This is NOT meant to be perfect; it exists to add an extra permission gate ("bash_dangerous")
   * on top of the normal bash permission flow.
   */
  export function reasons(command: string): string[] {
    const c = command.toLowerCase()
    const found: string[] = []

    // fork bomb
    if (c.includes(":(){") && c.includes(":|:") && c.includes("&")) {
      found.push("Possible fork bomb pattern")
    }

    // destructive rm
    if (/\brm\b/.test(c) && /\s-.*\br\b/.test(c) && /\s-.*\bf\b/.test(c)) {
      if (/\brm\b[^\n]*\s\/(\s|$)/.test(c) || /\brm\b[^\n]*\s\/\*/.test(c)) {
        found.push("rm -rf targeting root")
      } else {
        found.push("rm -rf detected")
      }
    }

    // filesystem formatting / raw disk writes
    if (/\bmkfs(\.| )/.test(c) || /\bmkfs\b/.test(c)) found.push("Filesystem format tool (mkfs) detected")
    if (/\bdd\b/.test(c) && (c.includes("of=/dev/") || c.includes("if=/dev/zero"))) {
      found.push("Raw disk write pattern (dd) detected")
    }

    // privilege escalation + remote script execution
    if (/\bsudo\b/.test(c)) found.push("sudo detected")
    if (/(curl|wget)\b[^\n]*\|\s*(sh|bash)\b/.test(c)) found.push("Remote script piped to shell detected")

    // power management / reboot
    if (/\bshutdown\b/.test(c) || /\breboot\b/.test(c) || /\bhalt\b/.test(c)) {
      found.push("System power command detected")
    }

    // mass process kill
    if (/\bkill\b/.test(c) && (c.includes(" -9 -1") || c.includes(" -kill -1"))) {
      found.push("Potentially dangerous kill pattern detected")
    }

    return found
  }

  export function isDangerous(command: string): boolean {
    return reasons(command).length > 0
  }
}

