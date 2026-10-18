import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process"
import { once } from "node:events"
import { text } from "node:stream/consumers"

import { z } from "zod"

/** Observe execFile completion and output while retaining its native buffering, timeout and abort bounds. */
export const runFile = async (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding
) => {
  const child = execFile(file, args, options)

  if (child.stdout === null || child.stderr === null) {
    throw new Error("child output streams are unavailable")
  }

  const [out, err, completion] = await Promise.allSettled([
    text(child.stdout),
    text(child.stderr),
    once(child, "close"),
  ])

  const stdout = out.status === "fulfilled" ? out.value : ""
  const stderr = err.status === "fulfilled" ? err.value : ""

  if (completion.status === "rejected") {
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, "close")
    }

    const failure =
      completion.reason instanceof Error
        ? completion.reason
        : new Error("child process failed")

    throw Object.assign(failure, { killed: child.killed, stderr, stdout })
  }

  const [code, signal] = z
    .tuple([z.number().nullable(), z.string().nullable()])
    .parse(completion.value)

  if (code !== 0) {
    throw Object.assign(
      new Error(`Command failed: ${file} ${args.join(" ")}\n${stderr}`),
      { code, killed: child.killed, signal, stderr, stdout }
    )
  }

  if (out.status === "rejected" || err.status === "rejected") {
    throw new Error("child output stream failed")
  }

  return { stderr, stdout }
}
