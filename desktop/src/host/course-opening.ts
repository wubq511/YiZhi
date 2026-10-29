import type { CourseService } from '../core/course-service';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { durableJSON } from '../core/backup';

interface AutomaticUpgrade {
  schema: 'yizhi-automatic-upgrade-1';
  upgradeId: string;
  directory: string;
  backupDirectory: string;
}

/** Normal course admission, shared by every learning-window entry. */
export class CourseOpening {
  private pending = new Map<string, ReturnType<CourseOpening['admit']>>();
  constructor(private core: CourseService) {}
  async open(directory: string) {
    directory = await realpath(directory).catch(error => {
      if (error.code === 'ENOENT') return resolve(directory);
      throw error;
    });
    const existing = this.pending.get(directory);
    if (existing) return existing;
    const pending = this.admit(directory).finally(() => this.pending.delete(directory));
    this.pending.set(directory, pending);
    return pending;
  }
  private async admit(directory: string) {
    if (!existsSync(join(directory, 'course.sqlite'))) return { directory, opened: await this.core.open(directory) };
    directory = (await this.core.upgrade.recover({ directory })).directory;
    const format = await this.core.format.inspect({ directory });
    if (!format.writable || format.courseFormat !== 1) return { directory, opened: await this.core.open(directory) };
    const preceding = await this.core.upgrade.status({ directory });
    if (preceding.role === 'source' && preceding.decision?.kind === 'format-upgrade'
      && preceding.decision.phase === 'verified' && !preceding.decision.abandonedAt) {
      const opened = await this.core.open(directory);
      await this.core.upgrade.publish({ sessionId: opened.sessionId, upgradeId: preceding.decision.operationId.slice('upgrade:'.length) });
      const recovered = await this.core.upgrade.recover({ directory });
      return { directory: recovered.directory, opened: await this.core.open(recovered.directory) };
    }
    // Own the source before persisting its automatic maintenance reservation.
    const opened = await this.core.open(directory);
    const marker = join(directory, 'automatic-upgrade.json');
    let job: AutomaticUpgrade;
    if (existsSync(marker)) {
      job = JSON.parse(await readFile(marker, 'utf8'));
      if (job.schema !== 'yizhi-automatic-upgrade-1' || !/^[\w-]{1,100}$/.test(job.upgradeId)
        || job.directory !== directory + '.format2-' + job.upgradeId
        || job.backupDirectory !== directory + '.before-format2-' + job.upgradeId)
        throw new Error('课程维护记录无效，请保留课程并重新打开或使用完整备份恢复');
    } else {
      const upgradeId = randomUUID();
      job = { schema: 'yizhi-automatic-upgrade-1', upgradeId,
        directory: directory + '.format2-' + upgradeId, backupDirectory: directory + '.before-format2-' + upgradeId };
      await durableJSON(marker, job);
    }
    try {
      await this.core.upgrade.prepare({ sessionId: opened.sessionId, ...job, automatic: true });
      await this.core.upgrade.publish({ sessionId: opened.sessionId, upgradeId: job.upgradeId });
      const recovered = await this.core.upgrade.recover({ directory });
      return { directory: recovered.directory, opened: await this.core.open(recovered.directory) };
    } catch (error) {
      throw new Error('课程维护未完成，原课程与已完成的备份仍保留。请检查原因后重新打开课程。' + (error as Error).message);
    }
  }
}
