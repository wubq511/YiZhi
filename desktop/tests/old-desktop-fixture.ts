import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { CourseService } from '../src/core/course-service';

/** A supported old desktop format, rather than making new courses start old. */
export async function oldDesktopCourse(core: CourseService, directory: string) {
  const opened = await core.open(directory);
  const db = new DatabaseSync(join(directory, 'course.sqlite'));
  try { db.exec("PRAGMA user_version=1; DELETE FROM metadata WHERE key='minimum-reader'"); }
  finally { db.close(); }
  return core.read(opened.sessionId);
}
