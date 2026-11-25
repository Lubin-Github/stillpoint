import { createRequire, isBuiltin } from 'node:module';
import { compileFunction } from 'node:vm';

const hostRequire = createRequire(import.meta.url);
function requireBuiltin(name) {
  if (typeof name !== 'string' || !isBuiltin(name)) throw new Error('托管插件只能直接加载 Node 内置模块。');
  return hostRequire(name);
}

function loadEntry(item) {
  const mod = { exports: {} };
  const execute = compileFunction(item.source.replace(/^\uFEFF?#![^\n]*/, ''), ['module', 'exports', 'require'], {
    filename: `dsh-managed-${item.id}.cjs`,
  });
  execute.call(mod.exports, mod, mod.exports, requireBuiltin);
  if (typeof mod.exports === 'function') return mod.exports;
  if (typeof mod.exports?.apply === 'function') return mod.exports.apply.bind(mod.exports);
  throw new Error('托管插件必须导出函数或包含 apply 方法的对象。');
}

// Imported code runs with Host process permissions, like other Host plugins.
// compileFunction avoids writing files and adding entries to require.cache.
export class ManagedPlugins {
  constructor(ctx) {
    this.ctx = ctx;
    this.entries = new Map();
  }

  list() {
    return Array.from(this.entries.values(), ({ id, name }) => ({ id, name }));
  }

  async mount(item) {
    if (this.entries.has(item.id)) throw new Error('Duplicate managed plugin.');
    let fiber;
    let cleanupFailed = false;
    try {
      const apply = loadEntry(item);
      let started = false;
      fiber = this.ctx.plugin({
        name: `lock-gate-managed-${item.id}`,
        async apply(ctx) {
          try {
            const dispose = await apply(ctx);
            if (dispose != null && typeof dispose !== 'function') throw new Error('Invalid disposer.');
            started = true;
            if (dispose) return async () => {
              try { await dispose(); } catch { cleanupFailed = true; }
            };
          } catch {
            throw new Error('托管插件启动失败。');
          }
        },
      });
      await fiber;
      if (!started) throw new Error('Managed plugin did not start.');
      this.entries.set(item.id, { id: item.id, name: item.name, fiber, cleanupFailed: () => cleanupFailed });
    } catch {
      await fiber?.dispose();
      throw new Error('托管插件加载失败。');
    }
  }

  async mountAll(items) {
    for (const item of items) await this.mount(item);
  }

  async unmount(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      await entry.fiber.dispose();
      if (entry.cleanupFailed()) throw new Error('托管插件清理失败。');
    } finally {
      this.entries.delete(id);
    }
  }

  async unmountAll() {
    let failed = false;
    for (const id of Array.from(this.entries.keys()).reverse()) {
      try { await this.unmount(id); } catch { failed = true; }
    }
    if (failed) throw new Error('托管插件清理失败。');
  }
}
