import { deploymentLogs } from "@deployit/db";
import type { getDb } from "@deployit/db";

type Db = ReturnType<typeof getDb>;

export class DeploymentLogger {
  constructor(
    private readonly db: Db,
    private readonly deploymentId: number
  ) {}

  async info(line: string): Promise<void> {
    console.log(`[deploy ${this.deploymentId}] ${line}`);
    await this.db
      .insert(deploymentLogs)
      .values({ deploymentId: this.deploymentId, line, stream: "stdout" });
  }

  async err(line: string): Promise<void> {
    console.error(`[deploy ${this.deploymentId}] ${line}`);
    await this.db
      .insert(deploymentLogs)
      .values({ deploymentId: this.deploymentId, line, stream: "stderr" });
  }
}
