import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// 追加式运行日志（JSONL）。所有写入点先落日志再改内存，
// 进程崩溃后重启可重放恢复。文件属于运行产物，不得提交（见 .gitignore）。
export class Journal {
  constructor(path) {
    this.path = path;
    this.queue = Promise.resolve();
  }

  static async create(path) {
    await mkdir(dirname(path), { recursive: true });
    return new Journal(path);
  }

  append(event) {
    const line = `${JSON.stringify(event)}\n`;
    const pending = this.queue.then(() => appendFile(this.path, line, 'utf8'));
    this.queue = pending.catch(() => {}); // 单次失败不阻塞后续写入
    return pending;
  }

  async flush() {
    await this.queue;
  }

  static async load(path) {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // 崩溃可能留下半行（只会出现在文件尾部），跳过
      }
    }
    return events;
  }
}
