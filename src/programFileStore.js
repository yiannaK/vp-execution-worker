"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const UUID_FORMAT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROGRAM_SIZE = 512 * 1024;

class ProgramFileStore {
  constructor({ directory = "/tmp/vp-programs" } = {}) {
    if (typeof directory !== "string" || !directory.trim())
      throw new Error("VP program directory is required");
    this.directory = path.resolve(directory);
    this.artifacts = new Map();
  }

  async materialize(plan) {
    const workflowExecutionId = plan?.workflowExecutionId;
    const programSource = plan?.programSource;
    if (!UUID_FORMAT.test(String(workflowExecutionId || "")))
      throw new Error("Invalid VP workflow execution id");
    if (plan?.executionMode !== "generated-js")
      throw new Error("Only generated-JS plans can create VP program files");
    if (
      typeof programSource !== "string" ||
      !programSource.trim() ||
      programSource.length > MAX_PROGRAM_SIZE
    ) {
      throw new Error(
        "Generated VP program was not snapshotted or exceeds its size limit",
      );
    }

    const digest = crypto
      .createHash("sha256")
      .update(programSource)
      .digest("hex");
    const existing = this.artifacts.get(workflowExecutionId);
    if (existing) {
      if (existing.digest !== digest)
        throw new Error(
          "VP program snapshot changed for an existing workflow execution",
        );
      return existing;
    }

    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filePath = path.join(this.directory, `${workflowExecutionId}.js`);
    const source = `'use strict';\n\nglobalThis.__program = (${programSource});\n`;
    try {
      const diskSource = await fs.readFile(filePath, "utf8");
      if (diskSource !== source)
        throw new Error(
          "VP program file conflicts with the immutable execution snapshot",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporaryPath, source, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporaryPath, filePath);
    }

    const artifact = Object.freeze({
      workflowExecutionId,
      digest,
      filePath,
      source,
    });
    this.artifacts.set(workflowExecutionId, artifact);
    return artifact;
  }
}

module.exports = { ProgramFileStore, MAX_PROGRAM_SIZE };
