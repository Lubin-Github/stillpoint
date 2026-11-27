window.__ModuleLoader__.load({
  id: 'stillpoint',
  factory(require) {
    const React = require('react');
    const { createElement: h, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } = React;
    const NS = 'local.dsh-lock-gate';
    const API = '/dsh-lock-gate/api';
    const AUDIT_API = '/dsh-lock-gate/audit';
    const AUDIT_LIMIT = 500;
    const AUDIT_KINDS = new Set([
      'locked_startup', 'locked_manual', 'screen_locked_schedule', 'locked_schedule', 'unlocked_otp',
      'smtp_failed', 'smtp_secret_error', 'otp_expired', 'auth_failed', 'auth_cooldown', 'mail_rate_limited',
      'storage_error', 'managed_start_failed', 'managed_stop_failed', 'schedule_error', 'operation_failed',
    ]);
    const POLL_MS = 4000;
    const BACKGROUND_POLL_MS = 15000;
    const MAX_RETRY_MS = 30000;
    const INPUT_ACTIVE_MS = 90000;
    const ACTIVITY_HEARTBEAT_MS = 10000;
    const ACTIVITY_REQUEST_MS = 4000;
    const ACTIVITY_INPUTS = ['pointerdown', 'keydown', 'wheel'];
    const ACTIVITY_OPTIONS = { capture: true, passive: true };
    const MAX_SOURCE_BYTES = 128 * 1024;
    const DEFAULT_SCHEDULE = { enabled: false, cron: '0 18 * * 1-5', timezone: 'Asia/Shanghai' };
    const WEEKDAYS = [1, 2, 3, 4, 5];
    const WEEK = [...WEEKDAYS, 6, 0];

    function weeklyFromCron(cron) {
      const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-7](?:-[0-7])?(?:,[0-7](?:-[0-7])?)*)$/.exec(cron.trim());
      if (!match || +match[1] > 59 || +match[2] > 23) return null;
      const days = new Set();
      if (match[3] === '*') WEEK.forEach(day => days.add(day));
      else for (const part of match[3].split(',')) {
        const [start, end = start] = part.split('-').map(Number);
        if (start > end) return null;
        for (let day = start; day <= end; day++) days.add(day % 7);
      }
      return { time: `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`, days: WEEK.filter(day => days.has(day)) };
    }

    function cronFromWeekly(weekly, originalCron) {
      if (!weekly.days.length || !/^([01]\d|2[0-3]):[0-5]\d$/.test(weekly.time)) return '';
      const original = weeklyFromCron(originalCron);
      if (original?.time === weekly.time && original.days.every(day => weekly.days.includes(day))
        && original.days.length === weekly.days.length) return originalCron;
      const [hour, minute] = weekly.time.split(':').map(Number);
      const days = [...weekly.days].sort((a, b) => a - b);
      const dayField = days.length === 7 ? '*' : days.join(',');
      return `${minute} ${hour} * * ${dayField}`;
    }

    function scheduleDraft(schedule) {
      const weekly = weeklyFromCron(schedule.cron);
      return { ...schedule, advanced: !weekly, weekly: weekly ?? weeklyFromCron(DEFAULT_SCHEDULE.cron) };
    }
    const DEFAULT_SMTP = { host: '', port: 465, security: 'tls', user: '', from: '', to: '' };
    const QQ_SMTP = { host: 'smtp.qq.com', port: 465, security: 'tls' };
    const QQ_ADDRESS = '[^@\\s]+@[qQ][qQ][.][cC][oO][mM]';

    function smtpProvider(smtp) {
      if (!smtp.host) return 'qq';
      return smtp.host === QQ_SMTP.host && smtp.port === QQ_SMTP.port && smtp.security === QQ_SMTP.security
        && /@qq\.com$/i.test(smtp.user) && smtp.from === smtp.user && smtp.to === smtp.user ? 'qq' : 'custom';
    }

    function smtpFromForm(form, provider) {
      if (provider === 'qq') {
        const email = form.get('qqAddress').trim();
        return { ...QQ_SMTP, user: email, from: email, to: email, password: form.get('qqPassword').trim() };
      }
      return {
        host: form.get('host').trim(), port: Number(form.get('port')), security: form.get('security'),
        user: form.get('user').trim(), from: form.get('from').trim(), to: form.get('to').trim(), password: form.get('password'),
      };
    }
    const MODES = new Set(['setup', 'unlocked', 'locked', 'error']);

    const en = {
      title: 'Stillpoint',
      description: 'Set up email verification and choose when managed plugins lock.',
      loading: 'Checking lock status…', unavailable: 'Could not reach the lock service. Check the connection and try again.', retry: 'Check again',
      blocked: 'Unlock the workspace to change these settings.',
      configure: 'Configure SMTP', dismiss: 'Dismiss', close: 'Close',
      setupPrompt: 'Set up SMTP and send a test email before locking.',
      testPrompt: 'Send a test email to finish SMTP setup.',
      storageTitle: 'Lock storage unavailable',
      storageRecovery: 'Restart DeepSeek Harness and check again. If the error continues, check access to its storage and keep the existing encrypted data.',
      cleanupTitle: 'Managed plugins did not stop cleanly',
      cleanupRecovery: 'Restart DeepSeek Harness to finish stopping the managed plugins. Then check the lock status again.',
      lockConnecting: 'The lock status is still loading. You can request a code or try unlocking.',
      lockDisconnected: 'Could not check the lock status. You can retry the status check or submit the unlock form.',
      smtpTitle: 'Email verification', passwordTitle: 'Unlock password', provider: 'Email provider', qqProvider: 'QQ Mail', customProvider: 'Custom SMTP',
      qqAddress: 'QQ email address', qqCode: 'QQ Mail authorization code',
      qqHint: 'This address sends and receives the verification code.', qqKeepCode: 'Leave blank to keep the saved code for this address.',
      host: 'SMTP host', port: 'Port', security: 'Encryption',
      user: 'SMTP username', from: 'Sender email address', to: 'Recipient email address',
      smtpPassword: 'SMTP password or app password', keepPassword: 'Leave blank to keep the saved password if host, port, encryption, and username are unchanged.',
      scheduleTitle: 'Automatic lock', enable: 'Lock on a schedule', cron: 'Cron expression',
      cronTip: 'Minute, hour, day of month, month, day of week. For example, 0 18 * * 1-5 means weekdays at 18:00.',
      days: 'Days to lock', lockTime: 'Lock time', weekdays: 'Weekdays', daily: 'Every day',
      day0: 'Sunday', day1: 'Monday', day2: 'Tuesday', day3: 'Wednesday', day4: 'Thursday', day5: 'Friday', day6: 'Saturday',
      shortDay0: 'Sun', shortDay1: 'Mon', shortDay2: 'Tue', shortDay3: 'Wed', shortDay4: 'Thu', shortDay5: 'Fri', shortDay6: 'Sat',
      schedulePreview: '{days} at {time} ({zone})', daysSeparator: ', ', shanghaiZone: 'China Standard Time',
      auditTitle: 'Lock history', auditHint: 'Last 15 days, up to 500 events. Times are shown in your local time zone.',
      auditRefresh: 'Refresh history', auditLoading: 'Loading lock history…', auditEmpty: 'No recent events.',
      auditUnavailable: 'Could not load lock history. Try refreshing.',
      auditTemporary: 'Log storage is unavailable. Recent events are held in memory and may be lost when DSH restarts.',
      auditScheduledFor: 'Scheduled for {time}',
      audit_locked_startup: 'Locked at startup', audit_locked_manual: 'Locked manually',
      audit_screen_locked_schedule: 'Scheduled screen lock',
      audit_locked_schedule: 'Scheduled lock completed', audit_unlocked_otp: 'Unlocked with email code',
      audit_smtp_failed: 'Email delivery failed', audit_smtp_secret_error: 'Could not read the SMTP credential',
      audit_otp_expired: 'Email code expired', audit_auth_failed: 'Verification failed',
      audit_auth_cooldown: 'Verification temporarily paused', audit_mail_rate_limited: 'Email sending rate limit reached',
      audit_storage_error: 'Lock storage error', audit_managed_start_failed: 'Could not start managed plugins',
      audit_managed_stop_failed: 'Could not stop managed plugins', audit_schedule_error: 'Scheduled lock failed',
      audit_operation_failed: 'Lock operation failed',
      scheduleOff: 'Off', advancedSchedule: 'Advanced · Cron', weeklySchedule: 'Use weekly schedule',
      resetSchedule: 'Replace this custom rule with a weekly schedule? The change takes effect when you save.',
      invalidWeekly: 'Select at least one day and enter a lock time.',
      invalidTimezone: 'Enter a valid time zone, such as Asia/Shanghai.',
      scheduleAfterTest: 'The schedule takes effect after email verification.',
      scheduleDeferred: 'Scheduled lock is waiting for workspace activity to end.',
      timezone: 'Time zone', masterNew: 'Create master password', masterConfirm: 'Confirm master password',
      master: 'Master password', masterCurrent: 'Current master password',
      masterTip: 'Use at least 12 characters. Keep this password for changing settings and unlocking managed plugins.',
      masterMismatch: 'The master passwords do not match.',
      testTip: 'The test uses your saved email settings. After a restart, enter the current master password if the lock service asks for it.',
      smtpPending: 'Save your email settings, then send a test email before locking.',
      smtpNeedsTest: 'Send a test email to verify these settings before locking.',
      smtpChangePending: 'Send a test email to apply these changes. The lock still uses the previously verified email settings.',
      smtpReady: 'Email verified', save: 'Save settings', test: 'Send test email', saved: 'Settings saved.',
      tested: 'Test email sent. Check your inbox.', lock: 'Lock now', confirmLock: 'Lock now? Unlocking requires the master password and an email code.',
      managedTitle: 'Managed plugins ({count})', empty: 'No plugins are managed yet.',
      manageAfterTest: 'Verify email before managing plugins.',
      importTip: 'Choose one trusted, self-contained .cjs plugin. The lock service imports a copy and runs its code when unlocked.',
      file: 'Plugin file', import: 'Import plugin', invalidFile: 'Choose one non-empty .cjs file up to 128 KiB.',
      invalidEncoding: 'The plugin file must contain valid UTF-8 text.',
      imported: 'Plugin imported.', remove: 'Remove', removeNamed: 'Remove {name}',
      confirmRemove: 'Remove {name} from managed plugins?', removed: 'Plugin removed.',
      lockedTitle: 'Workspace locked', lockedDescription: 'Enter your master password to request an email code, or enter a valid 6-digit code sent within the last 10 minutes to unlock.',
      lockedWindow: 'shell.overlay · Stillpoint Lock Gate',
      lockBadgeLocked: 'LOCKED', lockBadgeDraining: 'DRAINING', lockBadgeAlert: 'ATTENTION',
      lockedDrainingTitle: 'Draining background work', lockedDrainingBadge: 'ACTIVE',
      lockedDraining: 'Background tasks are still running. Managed plugins will stop when those tasks finish if the workspace is still locked.',
      masterPlaceholder: 'Enter master password',
      lockedVaultSpec: 'ARGON2ID (64 MiB, 3 ITER) · AES-256-GCM',
      codeSpec: '6-DIGIT SINGLE-USE CODE',
      codeDigit: 'Verification digit {index} of {total}',
      unlockLocked: 'Unlock',
      sendingCode: 'Sending…', unlockingVault: 'Unlocking…',
      lockedFooter: 'Stillpoint · Encrypted Host Vault · Zero-Secret Audit',
      checking: 'Checking the workspace lock…', lockError: 'The workspace remains locked. Check the lock service again to continue.',
      code: 'Email OTP verification', send: 'Send code', unlock: 'Unlock', codeSent: 'Code sent. Check your inbox.',
      requestFailed: 'The request did not complete. Check the connection and try again.',
      saveFailed: 'Could not save the settings. Check the email fields, schedule, and master password.',
      testFailed: 'Could not send the test email. Check the saved SMTP settings and enter the current master password if needed.',
      lockFailed: 'Could not lock the workspace. Check that email has been verified.',
      sendFailed: 'Could not send a code. Check the master password and try again.',
      unlockFailed: 'Could not unlock. Check the master password and enter a valid 6-digit email code.',
      rateLimited: 'Too many requests or failed attempts.',
      importFailed: 'Could not import this plugin. Check the file and master password.',
      removeFailed: 'Could not remove this plugin. Check the master password.',
      retryAt: 'Try again after {time}.', working: 'Working…',
    };
    const zh = {
      title: 'Stillpoint', description: '配置邮箱验证码并设置托管插件的锁定时间。',
      loading: '正在检查锁定状态…', unavailable: '无法连接锁定服务，请检查连接后重试。', retry: '重新检查',
      blocked: '解锁工作区后才能修改这些设置。',
      configure: '配置 SMTP', dismiss: '稍后', close: '关闭',
      setupPrompt: '尚未配置 SMTP。请填写邮件设置并发送测试邮件后再锁定。',
      testPrompt: '请发送测试邮件，完成 SMTP 配置。',
      storageTitle: 'Stillpoint 存储不可用',
      storageRecovery: '请重启 DeepSeek Harness 后重新检查。若问题持续，请检查存储访问权限并保留现有密文数据。',
      cleanupTitle: '托管插件未能正常停止',
      cleanupRecovery: '请重启 DeepSeek Harness 以停止托管插件，然后重新检查锁定状态。',
      lockConnecting: '正在读取锁定状态。你仍可以申请验证码或尝试解锁。',
      lockDisconnected: '暂时无法读取锁定状态。你可以重新检查连接，也可以提交解锁表单。',
      smtpTitle: '邮箱验证', passwordTitle: '解锁密码', provider: '邮箱服务', qqProvider: 'QQ 邮箱', customProvider: '自定义 SMTP',
      qqAddress: 'QQ 邮箱地址', qqCode: 'QQ 邮箱授权码',
      qqHint: '验证码由此邮箱发出，也发送到此邮箱。', qqKeepCode: '邮箱地址不变时，留空可沿用已保存的授权码。',
      host: 'SMTP 服务器', port: '端口', security: '加密方式',
      user: 'SMTP 用户名', from: '发件地址', to: '收件地址',
      smtpPassword: 'SMTP 密码或授权码', keepPassword: '服务器、端口、加密方式与用户名均未改变时，留空可沿用已保存的密码。',
      scheduleTitle: '自动锁定', enable: '按计划锁定', cron: 'Cron 表达式',
      cronTip: '依次填写分钟、小时、日、月、星期。例如 0 18 * * 1-5 表示周一至周五 18:00。',
      days: '每周锁定日', lockTime: '锁定时间', weekdays: '周一至周五', daily: '每天',
      day0: '星期日', day1: '星期一', day2: '星期二', day3: '星期三', day4: '星期四', day5: '星期五', day6: '星期六',
      shortDay0: '周日', shortDay1: '周一', shortDay2: '周二', shortDay3: '周三', shortDay4: '周四', shortDay5: '周五', shortDay6: '周六',
      schedulePreview: '{days} {time}（{zone}）', daysSeparator: '、', shanghaiZone: '北京时间',
      auditTitle: '锁定日志', auditHint: '保留最近 15 天，最多 500 条。时间按本机时区显示。',
      auditRefresh: '刷新日志', auditLoading: '正在读取锁定日志…', auditEmpty: '暂无近期记录。',
      auditUnavailable: '无法读取锁定日志，请尝试刷新。',
      auditTemporary: '日志存储暂不可用。近期记录暂存在内存中，重启 DSH 后可能丢失。',
      auditScheduledFor: '计划时间 {time}',
      audit_locked_startup: '启动时锁定', audit_locked_manual: '手动锁定',
      audit_screen_locked_schedule: '定时锁定界面',
      audit_locked_schedule: '定时锁定完成', audit_unlocked_otp: '通过邮件验证码解锁',
      audit_smtp_failed: '邮件发送失败', audit_smtp_secret_error: '无法读取 SMTP 凭据',
      audit_otp_expired: '邮件验证码已过期', audit_auth_failed: '身份验证失败',
      audit_auth_cooldown: '身份验证暂时受限', audit_mail_rate_limited: '已达邮件发送频率上限',
      audit_storage_error: '锁定数据存储异常', audit_managed_start_failed: '托管插件启动失败',
      audit_managed_stop_failed: '托管插件停止失败', audit_schedule_error: '定时锁定失败',
      audit_operation_failed: '锁定服务操作失败',
      scheduleOff: '未开启', advancedSchedule: '高级规则（Cron）', weeklySchedule: '改用每周计划',
      resetSchedule: '改用每周计划会替换当前自定义规则，保存设置后生效。确定切换吗？',
      invalidWeekly: '请选择至少一天并填写锁定时间。',
      invalidTimezone: '请输入有效的时区，例如 Asia/Shanghai。',
      scheduleAfterTest: '计划将在邮箱验证通过后生效。',
      scheduleDeferred: '定时锁定已延后，将在工作区活动结束后执行。',
      timezone: '时区', masterNew: '设置主密码', masterConfirm: '确认主密码', master: '主密码',
      masterCurrent: '当前主密码', masterTip: '至少使用 12 个字符。修改设置和解锁托管插件都需要此密码。',
      masterMismatch: '两次输入的主密码不一致。',
      testTip: '测试使用已保存的邮箱设置。服务重启后，若提示需要主密码，请先填写当前主密码。',
      smtpPending: '请先保存邮箱设置，再发送测试邮件以启用锁定。',
      smtpNeedsTest: '请发送测试邮件以验证当前设置。验证成功后即可锁定。',
      smtpChangePending: '请发送测试邮件以启用新设置。锁定服务在验证成功前仍使用原先已验证的邮箱设置。',
      smtpReady: '邮箱已验证', save: '保存设置', test: '发送测试邮件', saved: '设置已保存。',
      tested: '测试邮件已发送，请检查收件箱。', lock: '立即锁定', confirmLock: '立即锁定？解锁需要主密码和邮件验证码。',
      managedTitle: '托管插件（{count}）', empty: '暂无托管插件。',
      manageAfterTest: '邮箱验证成功后即可管理插件。',
      importTip: '请选择一个可信的、可独立运行的 .cjs 插件。服务会导入副本，并在解锁时运行插件代码。',
      file: '插件文件', import: '导入插件', invalidFile: '请选择一个非空且不超过 128 KiB 的 .cjs 文件。',
      invalidEncoding: '插件文件必须使用 UTF-8 编码。',
      imported: '插件已导入。', remove: '移除', removeNamed: '移除 {name}', confirmRemove: '移除托管插件 {name}？', removed: '插件已移除。',
      lockedTitle: '工作区已锁定', lockedDescription: '输入主密码发送邮箱验证码，或填入 10 分钟内已收到的 6 位验证码解锁工作区。',
      lockedWindow: 'shell.overlay · Stillpoint Lock Gate',
      lockBadgeLocked: '已锁定', lockBadgeDraining: '任务收尾中', lockBadgeAlert: '需处理',
      lockedDrainingTitle: '后台任务平稳收尾中', lockedDrainingBadge: '运行中',
      lockedDraining: '后台任务仍在运行。如果工作区在任务结束时仍处于锁定状态，托管插件将自动停止。',
      masterPlaceholder: '输入主密码',
      lockedVaultSpec: 'ARGON2ID (64 MiB, 3 ITER) · AES-256-GCM',
      codeSpec: '6 位单次有效验证码',
      codeDigit: '第 {index} 位验证码（共 {total} 位）',
      unlockLocked: '验证解锁',
      sendingCode: '正在发信…', unlockingVault: '正在解锁…',
      lockedFooter: 'Stillpoint · 托管插件内存隔离 · 零敏感日志',
      checking: '正在检查工作区锁定状态…', lockError: '工作区仍处于锁定状态。请重新检查锁定服务。',
      code: '邮箱验证码校验', send: '发送验证码', unlock: '解锁', codeSent: '验证码已发送，请检查收件箱。',
      requestFailed: '请求未完成，请检查连接后重试。',
      saveFailed: '无法保存设置，请检查邮箱字段、定时设置和主密码。',
      testFailed: '无法发送测试邮件，请检查已保存的 SMTP 设置，必要时输入当前主密码。',
      lockFailed: '无法锁定工作区，请确认邮箱已验证。',
      sendFailed: '无法发送验证码，请检查主密码后重试。',
      unlockFailed: '无法解锁，请检查主密码并输入有效的 6 位邮件验证码。',
      rateLimited: '请求过于频繁或尝试次数过多。',
      importFailed: '无法导入插件，请检查文件和主密码。',
      removeFailed: '无法移除插件，请检查主密码。',
      retryAt: '请在 {time} 后重试。', working: '正在处理…',
    };

    const styles = `
      .dsh-lock-page, .dsh-lock-dialog { color: var(--dsw-alias-label-primary); font: inherit; line-height: 1.5; }
      .dsh-lock-page { display: grid; gap: 16px; max-width: 720px; }
      .dsh-lock-page h2, .dsh-lock-card h3, .dsh-lock-dialog h2 { margin: 0; font-weight: 650; }
      .dsh-lock-page h2, .dsh-lock-dialog h2 { font-size: 21px; line-height: 1.3; }
      .dsh-lock-card h3, .dsh-lock-card legend { font-size: 14px; font-weight: 650; }
      .dsh-lock-page p, .dsh-lock-dialog p { margin: 0; overflow-wrap: anywhere; }
      .dsh-lock-hint { color: var(--dsw-alias-label-secondary); font-size: 13px; }
      .dsh-lock-status { font-size: 13px; }
      .dsh-lock-error { color: var(--dsw-alias-state-error-primary); }
      .dsh-lock-card, .dsh-lock-grid, .dsh-lock-field, .dsh-lock-stack { display: grid; min-width: 0; }
      .dsh-lock-card { gap: 16px; padding: 18px; border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 14px; background: var(--dsw-alias-bg-layer-1); }
      .dsh-lock-stack { gap: 12px; }
      .dsh-lock-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 174px), 1fr)); gap: 14px; align-items: start; }
      .dsh-lock-field { gap: 5px; align-content: start; font-size: 14px; }
      .dsh-lock-field > span:first-child { font-weight: 550; }
      .dsh-lock-page fieldset, .dsh-lock-dialog fieldset { border: 0; padding: 0; margin: 0; min-inline-size: 0; }
      .dsh-lock-page legend, .dsh-lock-dialog legend { padding: 0; margin: 0 0 10px; }
      .dsh-lock-page [hidden] { display: none !important; }
      .dsh-lock-page :is(input:not([type=checkbox]), select), .dsh-lock-dialog input:not([type=checkbox]) { box-sizing: border-box;
        width: 100%; min-width: 0; height: 40px; padding: 7px 10px; border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l2); color: inherit; background: var(--dsw-alias-bg-layer-2); font: inherit; }
      .dsh-lock-page :is(input, select, button, summary, .dsh-lock-audit-list):focus-visible,
      .dsh-lock-dialog :is(input, button, summary, .dsh-lock-audit-list):focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dsh-lock-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .dsh-lock-check { display: flex; align-items: center; gap: 8px; width: fit-content; cursor: pointer; }
      .dsh-lock-page .dsh-lock-check input { appearance: auto; flex: none; accent-color: var(--dsw-alias-brand-primary);
        inline-size: 16px; block-size: 16px; min-block-size: 0; padding: 0; margin: 0; }
      .dsh-lock-provider { max-width: 240px; }
      .dsh-lock-editor { gap: 18px; }
      .dsh-lock-page .dsh-lock-editor > fieldset { padding-block-end: 16px; border-block-end: 1px solid var(--dsw-alias-border-l1); }
      .dsh-lock-test-status { display: flex; align-items: baseline; gap: 8px; }
      .dsh-lock-test-status::before { content: ''; flex: none; align-self: flex-start; margin-top: 6px;
        width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
      .dsh-lock-test-status[data-verified]::before { background: var(--dsw-alias-state-success-primary); }
      .dsh-lock-schedule { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
      .dsh-lock-schedule summary { cursor: pointer; padding: 10px 12px; font-size: 14px; font-weight: 550; }
      .dsh-lock-schedule > fieldset { padding: 0 12px 12px; }
      .dsh-lock-days { display: flex; flex-wrap: wrap; gap: 8px; }
      .dsh-lock-days button { min-width: 52px; }
      .dsh-lock-schedule-caption { margin-inline-start: 8px; font-weight: 400; }
      .dsh-lock-schedule-mode { justify-self: start; }
      .dsh-lock-audit { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
        background: var(--dsw-alias-bg-layer-2); min-inline-size: 0; }
      .dsh-lock-audit summary { cursor: pointer; padding: 10px 12px; font-size: 14px; font-weight: 550; }
      .dsh-lock-audit-body { padding: 0 12px 12px; }
      .dsh-lock-audit-body button[aria-disabled=true] { opacity: .55; cursor: default; }
      .dsh-lock-audit-list { max-block-size: min(240px, 32vh); overflow: auto; overscroll-behavior: contain;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
      .dsh-lock-audit-list ol { list-style: none; margin: 0; padding: 0; }
      .dsh-lock-audit-list li { padding: 8px 10px; font-size: 14px; }
      .dsh-lock-audit-list li + li { border-block-start: 1px solid var(--dsw-alias-border-l1); }
      .dsh-lock-audit-time { display: block; font-variant-numeric: tabular-nums; }
      .dsh-lock-status:has(p:empty + p:empty) { display: none; }
      .dsh-lock-button { min-height: 36px; padding: 7px 12px; border-radius: 8px; cursor: pointer; font: inherit;
        font-size: 14px; font-weight: 550; border: 1px solid var(--dsw-alias-border-l2);
        color: inherit; background: var(--dsw-alias-bg-layer-1); }
      .dsh-lock-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .dsh-lock-button[data-primary] { color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
        background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary)); border-color: transparent; }
      .dsh-lock-button[data-primary]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-label-primary)); }
      .dsh-lock-button:disabled, .dsh-lock-page :is(input, select):disabled { opacity: .55; cursor: default; }
      .dsh-lock-list { margin: 0; padding: 0; list-style: none; }
      .dsh-lock-list li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-block: 6px;
        border-block-start: 1px solid var(--dsw-alias-border-l1); }
      .dsh-lock-list li span { overflow-wrap: anywhere; }
      .dsh-lock-dialog { box-sizing: border-box; width: min(440px, calc(100% - 32px)); max-height: calc(100% - 32px);
        margin: auto; padding: 24px; overflow: auto; overscroll-behavior: contain; border-radius: 18px;
        border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); pointer-events: auto; }
      .dsh-lock-dialog::backdrop { background: var(--dsw-alias-bg-base); pointer-events: auto; }
      .dsh-lock-gate-dialog { color-scheme: dark; width: min(484px, calc(100% - 28px)); max-height: calc(100dvh - 28px);
        padding: 0; border-radius: 20px; color: #f0f9ff;
        border: 1px solid rgba(56, 189, 248, 0.28);
        background: linear-gradient(180deg, #0d2236 0%, #091827 100%);
        box-shadow: inset 0 1px 0 rgba(186, 230, 253, 0.14), 0 28px 80px rgba(2, 8, 18, 0.78), 0 0 48px rgba(14, 116, 144, 0.2); }
      .dsh-lock-gate-dialog::backdrop { pointer-events: auto;
        background-color: #071522;
        background-image:
          radial-gradient(circle at 50% 48%, rgba(14, 116, 144, 0.3) 0%, rgba(7, 21, 34, 0) 62%),
          radial-gradient(circle at 50% 48%, transparent 159px, rgba(125, 211, 252, 0.065) 160px, transparent 161px),
          radial-gradient(circle at 50% 48%, transparent 259px, rgba(125, 211, 252, 0.05) 260px, transparent 261px),
          radial-gradient(circle at 50% 48%, transparent 369px, rgba(125, 211, 252, 0.04) 370px, transparent 371px),
          radial-gradient(circle at 50% 48%, transparent 489px, rgba(125, 211, 252, 0.03) 490px, transparent 491px),
          linear-gradient(rgba(148, 163, 184, 0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(148, 163, 184, 0.03) 1px, transparent 1px);
        background-size: 100% 100%, 100% 100%, 100% 100%, 100% 100%, 100% 100%, 44px 44px, 44px 44px;
        background-position: center; }
      .dsh-lock-gate-dialog :is(input, button):focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }
      .dsh-lock-chrome { display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 11px 18px; border-block-end: 1px solid rgba(56, 189, 248, 0.15); background: rgba(6, 17, 29, 0.62); }
      .dsh-lock-chrome-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .dsh-lock-dots { display: inline-flex; align-items: center; gap: 6px; flex: none; }
      .dsh-lock-dots span { width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; }
      .dsh-lock-dots span:nth-child(2) { background: #0e7490; }
      .dsh-lock-dots span:nth-child(3) { background: #334e68; }
      .dsh-lock-chrome-title { color: #8fb0ca; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .dsh-lock-pill { flex: none; padding: 3px 9px; border-radius: 7px; font-size: 11px; font-weight: 650; letter-spacing: 0.04em;
        color: #bae6fd; background: rgba(22, 78, 99, 0.52); border: 1px solid rgba(125, 211, 252, 0.3);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .dsh-lock-pill[data-tone=draining] { color: #e0f2fe; background: rgba(14, 116, 144, 0.68); border-color: rgba(56, 189, 248, 0.55); }
      .dsh-lock-pill[data-tone=alert] { color: #fecdd3; background: rgba(159, 18, 57, 0.42); border-color: rgba(251, 113, 133, 0.48); }
      .dsh-lock-gate-body { display: grid; gap: 18px; padding: 22px 22px 20px; }
      .dsh-lock-hero { display: flex; align-items: center; gap: 14px; }
      .dsh-lock-emblem { flex: none; width: 48px; height: 48px; border-radius: 13px; display: grid; place-items: center;
        background: #164e63; border: 1px solid rgba(186, 230, 253, 0.35);
        box-shadow: 0 8px 24px rgba(8, 47, 73, 0.6), inset 0 1px 0 rgba(224, 242, 254, 0.22); }
      .dsh-lock-emblem svg { width: 32px; height: 32px; display: block; }
      .dsh-lock-hero-copy { display: grid; gap: 3px; min-width: 0; }
      .dsh-lock-gate-dialog h2 { color: #f8fafc; font-size: 20px; line-height: 1.28; letter-spacing: -0.01em; }
      .dsh-lock-subtitle { color: #89abc6; font-size: 13px; line-height: 1.45; }
      .dsh-lock-drain-card { display: grid; gap: 9px; padding: 13px 14px; border-radius: 12px;
        background: rgba(14, 116, 144, 0.16); border: 1px solid rgba(56, 189, 248, 0.38); }
      .dsh-lock-drain-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .dsh-lock-drain-title { display: flex; align-items: center; gap: 9px; font-size: 13.5px; font-weight: 650; color: #f0f9ff; }
      .dsh-lock-drain-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #38bdf8;
        box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.22); animation: dsh-lock-pulse 2.2s ease-in-out infinite; }
      .dsh-lock-drain-copy { color: #9ec0da; font-size: 12.5px; line-height: 1.45; }
      .dsh-lock-drain-bar { height: 5px; border-radius: 999px; overflow: hidden; background: rgba(6, 19, 32, 0.78); }
      .dsh-lock-drain-bar > span { display: block; width: 62%; height: 100%; border-radius: inherit;
        background: linear-gradient(90deg, #0ea5e9 0%, #38bdf8 60%, #7dd3fc 100%);
        animation: dsh-lock-progress 2.6s ease-in-out infinite alternate; }
      .dsh-lock-group { display: grid; gap: 8px; }
      .dsh-lock-label-row { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 10px; }
      .dsh-lock-label-main { font-size: 12px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; color: #9ec0da; }
      .dsh-lock-label-spec { font-size: 11px; letter-spacing: 0.04em; color: #7599b8;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .dsh-lock-pass-shell { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 5px 6px 5px 14px;
        border-radius: 11px; background: #061320; border: 1px solid rgba(125, 162, 190, 0.28);
        transition: border-color 140ms ease, box-shadow 140ms ease; }
      .dsh-lock-pass-shell:has(.dsh-lock-gate-input:focus) { border-color: #38bdf8;
        box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.18); }
      .dsh-lock-gate-dialog input.dsh-lock-gate-input { flex: 1 1 auto; width: auto; height: 36px; padding: 0; border: 0;
        border-radius: 0; background: transparent; color: #f0f9ff; font-size: 15px; outline: none; }
      .dsh-lock-gate-dialog input.dsh-lock-gate-input::placeholder { color: #6082a0; }
      .dsh-lock-gate-dialog input.dsh-lock-gate-input:focus-visible { outline: none; }
      .dsh-lock-pass-send { flex: none; min-height: 34px; padding: 0 12px; border-radius: 8px; cursor: pointer; font: inherit;
        font-size: 12.5px; font-weight: 600; color: #bae6fd; background: rgba(22, 78, 99, 0.56);
        border: 1px solid rgba(56, 189, 248, 0.34); transition: background 140ms ease, border-color 140ms ease; }
      .dsh-lock-pass-send:hover:not(:disabled) { background: rgba(14, 116, 144, 0.72); border-color: rgba(125, 211, 252, 0.56); }
      .dsh-lock-otp-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; }
      .dsh-lock-otp-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
      .dsh-lock-gate-dialog input.dsh-lock-otp-cell { width: 100%; height: 48px; padding: 0; text-align: center;
        border-radius: 10px; background: #061320; border: 1px solid rgba(125, 162, 190, 0.28);
        color: #f8fafc; font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums;
        transition: border-color 140ms ease, box-shadow 140ms ease, background 140ms ease; }
      .dsh-lock-gate-dialog input.dsh-lock-otp-cell[data-filled] { border-color: rgba(125, 211, 252, 0.42); background: #081a2b; }
      .dsh-lock-gate-dialog input.dsh-lock-otp-cell:focus { outline: none; border-color: #38bdf8;
        box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2); background: #091e32; }
      .dsh-lock-gate-btn { min-height: 48px; padding: 0 22px; border-radius: 10px; cursor: pointer; font: inherit;
        font-size: 14.5px; font-weight: 650; white-space: nowrap; color: #f0f9ff;
        background: linear-gradient(180deg, #1b7d98 0%, #135d75 100%);
        border: 1px solid rgba(125, 211, 252, 0.44);
        box-shadow: inset 0 1px 0 rgba(224, 242, 254, 0.22), 0 6px 18px rgba(8, 47, 73, 0.48);
        transition: filter 140ms ease, border-color 140ms ease; }
      .dsh-lock-gate-btn:hover:not(:disabled) { filter: brightness(1.08); border-color: rgba(186, 230, 253, 0.65); }
      .dsh-lock-gate-btn-secondary { min-height: 40px; padding: 0 16px; font-size: 13.5px;
        background: rgba(22, 78, 99, 0.48); border-color: rgba(56, 189, 248, 0.34); box-shadow: none; }
      .dsh-lock-gate-dialog :is(.dsh-lock-pass-send, .dsh-lock-gate-btn, input):disabled { opacity: 0.5; cursor: default; }
      .dsh-lock-gate-note { padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.45;
        color: #bae6fd; background: rgba(14, 116, 144, 0.2); border: 1px solid rgba(56, 189, 248, 0.34); }
      .dsh-lock-gate-note[data-tone=alert] { color: #fecdd3; background: rgba(159, 18, 57, 0.24);
        border-color: rgba(251, 113, 133, 0.44); }
      .dsh-lock-gate-dialog .dsh-lock-status p:not(:empty) { padding: 10px 12px; border-radius: 10px; font-size: 13px;
        line-height: 1.45; color: #e0f2fe; background: rgba(14, 116, 144, 0.22); border: 1px solid rgba(56, 189, 248, 0.36); }
      .dsh-lock-gate-dialog .dsh-lock-status p.dsh-lock-error:not(:empty) { color: #fecdd3;
        background: rgba(159, 18, 57, 0.24); border-color: rgba(251, 113, 133, 0.44); }
      .dsh-lock-gate-footer { padding: 11px 22px 13px; border-block-start: 1px solid rgba(56, 189, 248, 0.12);
        background: rgba(6, 17, 29, 0.45); color: #6e93b0; font-size: 11.5px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      @keyframes dsh-lock-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
      @keyframes dsh-lock-progress { 0% { transform: translateX(-18%); } 100% { transform: translateX(68%); } }
      @media (prefers-reduced-motion: reduce) {
        .dsh-lock-drain-dot, .dsh-lock-drain-bar > span { animation: none; }
      }
      @media (max-width: 460px) {
        .dsh-lock-gate-body { padding: 18px 16px 16px; }
        .dsh-lock-chrome, .dsh-lock-gate-footer { padding-inline: 16px; }
        .dsh-lock-otp-row { grid-template-columns: 1fr; }
        .dsh-lock-gate-btn { width: 100%; }
      }
      @media (pointer: coarse) { .dsh-lock-gate-dialog input.dsh-lock-gate-input { font-size: 16px; } }
      .dsh-lock-setup-dialog { width: min(680px, calc(100% - 32px)); padding: 0; overflow: hidden;
        max-height: min(760px, calc(100dvh - 48px)); box-shadow: 0 20px 68px var(--dsw-alias-bg-mask-2); }
      .dsh-lock-setup-dialog[open] { display: grid; grid-template-rows: auto minmax(0, 1fr); }
      .dsh-lock-setup-dialog::backdrop { background: var(--dsw-alias-bg-mask-1); }
      .dsh-lock-setup-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
        padding: 20px 24px 17px; border-block-end: 1px solid var(--dsw-alias-border-l1); }
      .dsh-lock-setup-header p { margin-block-start: 4px; }
      .dsh-lock-setup-body { padding: 18px 24px 22px; overflow: auto; overscroll-behavior: contain; }
      .dsh-lock-notice { position: fixed; inset-inline-end: 16px; inset-block-end: 16px;
        box-sizing: border-box; width: min(360px, calc(100% - 32px)); pointer-events: auto;
        color: var(--dsw-alias-label-primary); box-shadow: 0 8px 32px var(--dsw-alias-bg-mask-2); }
      .dsh-lock-notice p { margin: 0; }
      @media (max-width: 480px) {
        .dsh-lock-setup-header, .dsh-lock-setup-body { padding-inline: 14px; }
        .dsh-lock-setup-body .dsh-lock-card { padding: 14px; }
      }
      @media (pointer: coarse) { .dsh-lock-page :is(input, select), .dsh-lock-dialog input { font-size: 16px; } }
    `;

    function trackActivity(report) {
      if (typeof document.hasFocus !== 'function' || typeof window.crypto?.getRandomValues !== 'function') return () => {};
      const bytes = window.crypto.getRandomValues(new Uint8Array(16));
      const clientId = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      let lastInput = null;
      let lastReport = 0;
      let reportedActive = false;
      let pending = false;
      let stopped = false;
      let timer;

      function reevaluate() {
        window.clearTimeout(timer);
        if (pending) return;
        const now = Date.now();
        const inputAge = lastInput === null ? Infinity : now - lastInput;
        const active = !stopped && !document.hidden && document.hasFocus()
          && inputAge >= 0 && inputAge < INPUT_ACTIVE_MS;
        const sinceReport = now - lastReport;
        if (active !== reportedActive || (active && sinceReport >= ACTIVITY_HEARTBEAT_MS)) {
          pending = true;
          reportedActive = active;
          lastReport = now;
          void report(active, clientId).catch(() => {
            // A missed report expires on the host. Retry at the next normal heartbeat.
          }).finally(() => {
            pending = false;
            reevaluate();
          });
        } else if (active) {
          timer = window.setTimeout(reevaluate, Math.min(INPUT_ACTIVE_MS - inputAge, ACTIVITY_HEARTBEAT_MS - sinceReport));
        }
      }

      function input(event) {
        if (!event.isTrusted || document.hidden || !document.hasFocus()) return;
        lastInput = Date.now();
        reevaluate();
      }

      function suspend() {
        lastInput = null;
        reevaluate();
      }

      const reevaluateVisibility = () => { if (document.hidden) suspend(); else reevaluate(); };
      for (const type of ACTIVITY_INPUTS) window.addEventListener(type, input, ACTIVITY_OPTIONS);
      window.addEventListener('focus', reevaluate);
      window.addEventListener('blur', suspend);
      window.addEventListener('pagehide', suspend);
      document.addEventListener('visibilitychange', reevaluateVisibility);
      return () => {
        stopped = true;
        for (const type of ACTIVITY_INPUTS) window.removeEventListener(type, input, ACTIVITY_OPTIONS);
        window.removeEventListener('focus', reevaluate);
        window.removeEventListener('blur', suspend);
        window.removeEventListener('pagehide', suspend);
        document.removeEventListener('visibilitychange', reevaluateVisibility);
        reevaluate();
      };
    }

    function createLockService() {
      const boot = window.__DSH_LOCK_GATE_BOOT__;
      const initialMode = MODES.has(boot?.mode) ? boot.mode : window.__DSH_LOCK_GATE_INITIAL__ === true ? 'locked' : null;
      let snapshot = {
        mode: initialMode, issue: boot?.issue, pending: null, state: null, status: 'loading',
        draining: initialMode === 'locked' && boot?.draining === true,
        smtpConfigured: boot?.smtpConfigured === true,
      };
      let timer;
      let read;
      let write;
      let failures = 0;
      let disposed = false;
      const subscribers = new Set();

      function publish(next) {
        if (disposed) return;
        snapshot = { ...snapshot, ...next };
        for (const subscriber of subscribers) subscriber();
      }

      function normalizeState(state) {
        if (!MODES.has(state?.mode)) throw new Error('Missing lock state');
        if (state.mode === 'locked') return { mode: 'locked', draining: state.draining === true };
        if (state.mode === 'error') return { mode: 'error', issue: state.issue };
        const smtp = state.smtp && Object.fromEntries(Object.keys(DEFAULT_SMTP).map(key => [key, state.smtp[key]]));
        return {
          mode: state.mode, smtp, smtpConfigured: state.smtpConfigured === true, smtpVerified: state.smtpVerified === true,
          schedule: { ...DEFAULT_SCHEDULE, ...state.schedule },
          deferredLock: state.deferredLock === true,
          managedCount: typeof state.managedCount === 'number' ? state.managedCount : 0,
          managed: Array.isArray(state.managed)
            ? state.managed.filter(item => typeof item?.id === 'string' && typeof item?.name === 'string')
            : [],
        };
      }

      async function request(controller, timeout, payload, activity = false) {
        const expires = window.setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(API, {
            method: payload === undefined ? 'GET' : 'POST',
            credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
            signal: controller.signal,
            ...(activity && payload.active === false ? { keepalive: true } : {}),
            ...(payload === undefined ? {} : {
              headers: { 'Content-Type': 'application/json', 'X-DSH-Lock-Gate': '1' },
              body: JSON.stringify(payload),
            }),
          });
          if (activity) return;
          const result = await response.json();
          if (response.ok && result?.ok === true) return { ok: true, state: normalizeState(result.state) };
          if (result?.ok === false && typeof result.error === 'string') {
            const retryAt = Number.isFinite(result.retryAt) && result.retryAt > Date.now() && result.retryAt <= 8.64e15
              ? result.retryAt : undefined;
            return { ok: false, error: result.error, retryAt };
          }
          throw new Error('Invalid lock response');
        } finally {
          window.clearTimeout(expires);
        }
      }

      function schedule() {
        window.clearTimeout(timer);
        if (disposed || write) return;
        const interval = document.hidden ? BACKGROUND_POLL_MS : POLL_MS;
        timer = window.setTimeout(refresh, Math.min(interval * (2 ** Math.min(failures, 3)), MAX_RETRY_MS));
      }

      function publishState(state) {
        publish({ mode: state.mode, issue: state.issue, draining: state.draining === true, state,
          status: 'ready', smtpConfigured: state.smtpConfigured === true });
      }

      async function refresh() {
        if (disposed || read || write) return;
        window.clearTimeout(timer);
        const current = new AbortController();
        read = current;
        try {
          const result = await request(current, 8000);
          if (read !== current || disposed) return;
          if (!result.ok) throw new Error('Lock state request rejected');
          failures = 0;
          publishState(result.state);
        } catch {
          if (read !== current || disposed) return;
          failures += 1;
          publish({ status: 'unavailable' });
        } finally {
          if (read === current) {
            read = undefined;
            schedule();
          }
        }
      }

      function activate() {
        const recheck = () => { if (!document.hidden) void refresh(); };
        document.addEventListener('visibilitychange', recheck);
        window.addEventListener('online', recheck);
        const stopActivity = trackActivity((active, clientId) => request(new AbortController(), ACTIVITY_REQUEST_MS,
          { action: 'activity', active, clientId }, true));
        void refresh();
        return () => {
          disposed = true;
          stopActivity();
          document.removeEventListener('visibilitychange', recheck);
          window.removeEventListener('online', recheck);
          window.clearTimeout(timer);
          read?.abort();
          write?.abort();
          subscribers.clear();
        };
      }

      async function post(action, fields) {
        const allowed = action === 'send' || action === 'unlock'
          ? snapshot.mode === 'locked'
          : snapshot.status === 'ready' && (snapshot.mode === 'setup' || snapshot.mode === 'unlocked');
        if (disposed || write || !allowed) return null;
        const previousRead = read;
        read = undefined;
        previousRead?.abort();
        window.clearTimeout(timer);
        const current = new AbortController();
        write = current;
        publish({ pending: action });
        let result;
        try {
          result = await request(current, 30000, { action, ...fields });
          if (result.ok) {
            failures = 0;
            publishState(result.state);
          }
        } catch {
          result = { ok: false };
        } finally {
          write = undefined;
          publish({ pending: null });
          if (result?.ok) schedule();
          else void refresh();
        }
        return disposed ? null : result;
      }

      return {
        activate, refresh, post, getSnapshot: () => snapshot,
        subscribe(subscriber) {
          subscribers.add(subscriber);
          return () => subscribers.delete(subscriber);
        },
      };
    }

    function button(label, options = {}) {
      const { primary, ...props } = options;
      return h('button', { className: 'dsh-lock-button', type: 'button', 'data-primary': primary || undefined, ...props }, label);
    }

    function field(label, props, hint, choices) {
      return h('label', { className: 'dsh-lock-field' },
        h('span', null, label),
        choices ? h('select', props, choices.map(value => h('option', { key: value, value }, value === 'tls' ? 'TLS' : 'STARTTLS')))
          : h('input', props),
        hint && h('span', { className: 'dsh-lock-hint' }, hint),
      );
    }

    function passwordProps(name, extra) {
      return { name, type: 'password', autoComplete: 'new-password', spellCheck: false, ...extra };
    }

    function useFeedback(t, locale) {
      const [feedback, setFeedback] = useState(null);
      const retryAt = feedback?.retryAt;
      useEffect(() => {
        if (!retryAt || retryAt <= Date.now()) return;
        // Cap the timer to the browser's signed 32-bit range.
        const timer = window.setTimeout(() => setFeedback(current => current?.retryAt === retryAt ? null : current),
          Math.min(retryAt - Date.now() + 50, 2147483647));
        return () => window.clearTimeout(timer);
      }, [retryAt]);
      const action = feedback?.action;
      const language = locale.getSnapshot().active;
      const message = feedback?.hostMessage && /^zh(?:-|$)/i.test(language) ? feedback.hostMessage
        : feedback?.key ? t(feedback.key) : '';
      const retry = retryAt > Date.now()
        ? t('retryAt', { time: new Date(retryAt).toLocaleTimeString(language) }) : '';
      return {
        coolingDown: key => action === key && Boolean(retry),
        node: h('div', { className: 'dsh-lock-status' },
          h('p', { role: 'status' }, !feedback?.error && message),
          h('p', { role: 'alert', className: 'dsh-lock-error' }, feedback?.error && [message, retry].filter(Boolean).join(' '))),
        clear: () => setFeedback(null),
        show: (key, error = false) => setFeedback({ key, error }),
        result(res, key, success) {
          if (res?.ok) setFeedback(success ? { key: success } : null);
          else if (res) setFeedback({ key: res.retryAt ? 'rateLimited' : res.error ? `${key}Failed` : 'requestFailed', error: true,
            hostMessage: res.error, action: key, retryAt: res.retryAt });
          return res?.ok === true;
        },
      };
    }

    function SettingsEditor({ t, locale, service, snapshot, compact }) {
      const state = snapshot.state;
      const original = { ...DEFAULT_SMTP, ...state.smtp };
      const [plan, setPlan] = useState(() => scheduleDraft(state.schedule));
      const scheduleRef = useRef(null);
      const cron = plan.advanced ? plan.cron.trim() : cronFromWeekly(plan.weekly, state.schedule.cron);
      const sameWeekdays = plan.weekly.days.length === WEEKDAYS.length && WEEKDAYS.every(day => plan.weekly.days.includes(day));
      const daysLabel = sameWeekdays ? t('weekdays') : plan.weekly.days.length === 7 ? t('daily')
        : WEEK.filter(day => plan.weekly.days.includes(day)).map(day => t(`shortDay${day}`)).join(t('daysSeparator'));
      const planPreview = !plan.enabled ? t('scheduleOff') : plan.advanced ? t('advancedSchedule') : cron ? t('schedulePreview', {
        days: daysLabel, time: plan.weekly.time, zone: plan.timezone.trim() === 'Asia/Shanghai' ? t('shanghaiZone') : plan.timezone.trim() || '—',
      }) : t('invalidWeekly');
      const [provider, setProvider] = useState(() => smtpProvider(original));
      const [qqAddress, setQqAddress] = useState(() => /@qq\.com$/i.test(original.user) ? original.user : '');
      const qqPasswordRequired = !state.smtpConfigured || original.host !== QQ_SMTP.host || original.port !== QQ_SMTP.port
        || original.security !== QQ_SMTP.security || qqAddress.trim() !== original.user;
      const [readingFile, setReadingFile] = useState(false);
      const [transportPasswordRequired, setTransportPasswordRequired] = useState(!state.smtpConfigured);
      const feedback = useFeedback(t, locale);
      const editorRef = useRef(null);
      const importRef = useRef(null);
      const active = useRef(true);
      useEffect(() => {
        active.current = true;
        return () => { active.current = false; };
      }, []);
      const savedScheduleKey = JSON.stringify(state.schedule);
      const settingsKey = JSON.stringify([original, state.schedule]);
      useEffect(() => setPlan(scheduleDraft(state.schedule)), [savedScheduleKey]);
      useEffect(() => {
        setProvider(smtpProvider(original));
        setQqAddress(/@qq\.com$/i.test(original.user) ? original.user : '');
        setTransportPasswordRequired(!state.smtpConfigured);
      }, [settingsKey, state.smtpConfigured]);
      const canWrite = snapshot.status === 'ready';
      const busy = snapshot.pending !== null || readingFile;

      function transportChanged(form) {
        return form.get('host').trim().toLowerCase() !== original.host || Number(form.get('port')) !== original.port
          || form.get('security') !== original.security || form.get('user').trim() !== original.user;
      }

      function scheduleEditor() {
        const setDays = days => setPlan({ ...plan, weekly: { ...plan.weekly, days } });
        const dayPicker = h('fieldset', { className: 'dsh-lock-stack' },
          h('legend', null, t('days')),
          h('div', { className: 'dsh-lock-days' }, WEEK.map(day => button(t(`shortDay${day}`), {
            key: day, primary: plan.weekly.days.includes(day), 'aria-pressed': plan.weekly.days.includes(day),
            'aria-label': t(`day${day}`), onClick: () => toggleDay(day),
          }))),
          h('div', { className: 'dsh-lock-actions' },
            button(t('weekdays'), { onClick: () => setDays(WEEKDAYS) }),
            button(t('daily'), { onClick: () => setDays(WEEK) })));
        return h('details', { className: 'dsh-lock-schedule', ref: scheduleRef, open: state.schedule.enabled },
          h('summary', null, t('scheduleTitle'),
            h('span', { className: 'dsh-lock-hint dsh-lock-schedule-caption' }, planPreview)),
          h('fieldset', { disabled: busy, className: 'dsh-lock-stack' },
            h('label', { className: 'dsh-lock-check' },
              h('input', { type: 'checkbox', checked: plan.enabled,
                onChange: e => setPlan({ ...plan, enabled: e.target.checked }) }), t('enable')),
            plan.enabled && h(React.Fragment, null,
              plan.advanced ? field(t('cron'), { name: 'cron', value: plan.cron, maxLength: 100, spellCheck: false,
                onChange: e => setPlan({ ...plan, cron: e.target.value }) }, t('cronTip')) : dayPicker,
              h('div', { className: 'dsh-lock-grid' },
                !plan.advanced && field(t('lockTime'), { type: 'time', name: 'lockTime', value: plan.weekly.time,
                  onChange: e => setPlan({ ...plan, weekly: { ...plan.weekly, time: e.target.value } }) }),
                field(t('timezone'), { name: 'timezone', value: plan.timezone, maxLength: 80, spellCheck: false,
                  onChange: e => setPlan({ ...plan, timezone: e.target.value }) })),
              !state.smtpVerified && h('p', { className: 'dsh-lock-hint' }, t('scheduleAfterTest')),
              h('div', { className: 'dsh-lock-schedule-mode' },
                button(t(plan.advanced ? 'weeklySchedule' : 'advancedSchedule'), { onClick: switchScheduleMode })))));
      }

      function toggleDay(day) {
        setPlan(current => {
          const { days } = current.weekly;
          return { ...current, weekly: { ...current.weekly, days: days.includes(day)
            ? days.filter(value => value !== day) : [...days, day] } };
        });
      }

      function switchScheduleMode() {
        if (!plan.advanced) {
          setPlan({ ...plan, advanced: true, cron });
          return;
        }
        const weekly = weeklyFromCron(plan.cron);
        if (!weekly && !window.confirm(t('resetSchedule'))) return;
        setPlan({ ...plan, advanced: false, weekly: weekly ?? weeklyFromCron(DEFAULT_SCHEDULE.cron) });
      }

      async function save(event) {
        event.preventDefault();
        if (busy || !canWrite) return;
        const inputs = event.currentTarget.elements;
        const data = new FormData(event.currentTarget);
        const masterPassword = data.get('masterPassword');
        if (!state.smtpConfigured && masterPassword !== data.get('confirmPassword')) {
          inputs.confirmPassword.focus();
          feedback.show('masterMismatch', true);
          return;
        }
        const timezone = plan.timezone.trim();
        if (plan.enabled && (!cron || (plan.advanced && cron.split(/\s+/).length !== 5))) {
          scheduleRef.current.open = true;
          scheduleRef.current.querySelector(plan.advanced ? '[name="cron"]' : '.dsh-lock-days button')?.focus();
          feedback.show(plan.advanced ? 'cronTip' : 'invalidWeekly', true);
          return;
        }
        if (plan.enabled) {
          try {
            new Intl.DateTimeFormat('en', { timeZone: timezone });
          } catch {
            scheduleRef.current.open = true;
            inputs.timezone.focus();
            feedback.show('invalidTimezone', true);
            return;
          }
        }
        const smtp = smtpFromForm(data, provider);
        const schedule = plan.enabled ? { enabled: true, cron, timezone }
          : { ...state.schedule, enabled: false };
        inputs.masterPassword.value = '';
        inputs.password.value = '';
        inputs.qqPassword.value = '';
        if (inputs.confirmPassword) inputs.confirmPassword.value = '';
        feedback.clear();
        const result = await service.post('save', { smtp, schedule, masterPassword });
        if (active.current) feedback.result(result, 'save', 'saved');
      }

      async function test() {
        if (busy || !canWrite) return;
        const input = editorRef.current?.elements.masterPassword;
        const masterPassword = input?.value;
        if (input) input.value = '';
        feedback.clear();
        const result = await service.post('test', masterPassword ? { masterPassword } : {});
        if (active.current) feedback.result(result, 'test', 'tested');
      }

      async function lock() {
        if (busy || !canWrite || !window.confirm(t('confirmLock'))) return;
        feedback.clear();
        const result = await service.post('lock', {});
        if (active.current) feedback.result(result, 'lock');
      }

      async function importPlugin(event) {
        event.preventDefault();
        if (busy || !canWrite) return;
        const inputs = event.currentTarget.elements;
        const file = inputs.sourceFile.files[0];
        if (!file || !/\.cjs$/i.test(file.name) || file.size < 1 || file.size > MAX_SOURCE_BYTES) {
          feedback.show('invalidFile', true);
          return;
        }
        setReadingFile(true);
        feedback.clear();
        try {
          let source;
          try {
            source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
          } catch {
            if (active.current) feedback.show('invalidEncoding', true);
            return;
          }
          if (!active.current || service.getSnapshot().mode !== 'unlocked' || service.getSnapshot().status !== 'ready') return;
          const masterPassword = inputs.managePassword.value;
          inputs.managePassword.value = '';
          const result = await service.post('import', { source, name: file.name, masterPassword });
          if (active.current && feedback.result(result, 'import', 'imported')) inputs.sourceFile.value = '';
        } finally {
          if (active.current) setReadingFile(false);
        }
      }

      async function removePlugin({ id, name }) {
        if (busy || !canWrite) return;
        const input = importRef.current?.elements.managePassword;
        if (!input?.reportValidity() || !window.confirm(t('confirmRemove', { name }))) return;
        const masterPassword = input.value;
        input.value = '';
        feedback.clear();
        const result = await service.post('remove', { id, masterPassword });
        if (active.current) feedback.result(result, 'remove', 'removed');
      }

      const disabledFor = action => !canWrite || busy || feedback.coolingDown(action);
      let testState = 'smtpPending';
      if (state.smtpVerified) testState = 'smtpReady';
      else if (state.mode === 'unlocked') testState = 'smtpChangePending';
      else if (state.smtpConfigured) testState = 'smtpNeedsTest';
      const masterField = state.smtpConfigured ? 'masterCurrent' : 'masterNew';
      return h(React.Fragment, null,
        !compact && h('p', { className: 'dsh-lock-hint' }, t('description')),
        !canWrite && h(RecoveryNotice, { t, service }),
        h('form', { key: settingsKey, ref: editorRef, className: 'dsh-lock-card dsh-lock-editor', autoComplete: 'off', onSubmit: save,
          onInvalidCapture: event => {
            const details = event.target.closest('details');
            if (details) details.open = true;
          },
          'aria-busy': busy || undefined },
          h('fieldset', { disabled: busy, className: 'dsh-lock-stack' }, h('legend', null, t('smtpTitle')),
            h('label', { className: 'dsh-lock-field dsh-lock-provider' }, h('span', null, t('provider')),
              h('select', { value: provider, onChange: e => setProvider(e.target.value) },
                h('option', { value: 'qq' }, t('qqProvider')),
                h('option', { value: 'custom' }, t('customProvider')))),
            h('fieldset', { hidden: provider !== 'qq', disabled: provider !== 'qq' },
              h('div', { className: 'dsh-lock-grid' },
                field(t('qqAddress'), { name: 'qqAddress', type: 'email', value: qqAddress, required: true,
                  pattern: QQ_ADDRESS, placeholder: '123456@qq.com', autoComplete: 'email',
                  onChange: e => setQqAddress(e.target.value) }, t('qqHint')),
                field(t('qqCode'), passwordProps('qqPassword', { required: qqPasswordRequired }),
                  qqPasswordRequired ? null : t('qqKeepCode')))),
            h('fieldset', { hidden: provider !== 'custom', disabled: provider !== 'custom' },
            h('div', { className: 'dsh-lock-grid' },
              field(t('host'), { name: 'host', defaultValue: original.host, required: true, spellCheck: false,
                onChange: e => setTransportPasswordRequired(!state.smtpConfigured || transportChanged(new FormData(e.currentTarget.form))) }),
              field(t('port'), { name: 'port', type: 'number', defaultValue: original.port, min: 1, max: 65535, required: true,
                onChange: e => setTransportPasswordRequired(!state.smtpConfigured || transportChanged(new FormData(e.currentTarget.form))) }),
              field(t('security'), { name: 'security', defaultValue: original.security, required: true,
                onChange: e => setTransportPasswordRequired(!state.smtpConfigured || transportChanged(new FormData(e.currentTarget.form))) }, null, ['tls', 'starttls']),
              field(t('user'), { name: 'user', defaultValue: original.user, required: true, spellCheck: false,
                onChange: e => setTransportPasswordRequired(!state.smtpConfigured || transportChanged(new FormData(e.currentTarget.form))) }),
              field(t('from'), { name: 'from', type: 'email', defaultValue: original.from, required: true }),
              field(t('to'), { name: 'to', type: 'email', defaultValue: original.to, required: true })),
            h('div', { style: { marginTop: 10 } }, field(t('smtpPassword'), passwordProps('password', {
              required: transportPasswordRequired,
            }), state.smtpConfigured ? t('keepPassword') : null)))),
          h('fieldset', { disabled: busy },
            h('legend', null, t('passwordTitle')),
            h('div', { className: 'dsh-lock-grid' },
              field(t(masterField), passwordProps('masterPassword', { required: true, minLength: state.smtpConfigured ? undefined : 12 }),
                state.smtpConfigured ? null : t('masterTip')),
              !state.smtpConfigured && field(t('masterConfirm'), passwordProps('confirmPassword', { required: true, minLength: 12 })))),
          h('div', { className: 'dsh-lock-actions' },
            button(t('save'), { type: 'submit', primary: !state.smtpConfigured || state.smtpVerified, disabled: disabledFor('save') }),
            button(t('test'), { primary: state.smtpConfigured && !state.smtpVerified, disabled: disabledFor('test') || !state.smtpConfigured, onClick: test }),
            state.mode === 'unlocked' && button(t('lock'), { disabled: disabledFor('lock') || !state.smtpVerified, onClick: lock })),
          h('p', { className: 'dsh-lock-hint dsh-lock-test-status', role: 'status',
            'data-verified': state.smtpVerified || undefined }, t(testState)),
          state.smtpConfigured && !state.smtpVerified && h('p', { className: 'dsh-lock-hint' }, t('testTip')),
          feedback.node,
          scheduleEditor(),
          state.deferredLock && h('p', { className: 'dsh-lock-hint', role: 'status' }, t('scheduleDeferred')),
        ),
        (!compact || state.smtpVerified) && h('section', { className: 'dsh-lock-card' },
          h('h3', null, t('managedTitle', { count: state.managedCount })),
          state.mode === 'unlocked' && state.smtpVerified
            ? h(React.Fragment, null,
              h('p', { className: 'dsh-lock-hint' }, t('importTip')),
              h('form', { ref: importRef, className: 'dsh-lock-stack', autoComplete: 'off', onSubmit: importPlugin },
                h('fieldset', { disabled: busy }, h('div', { className: 'dsh-lock-grid' },
                  field(t('file'), { name: 'sourceFile', type: 'file', accept: '.cjs', required: true }),
                  field(t('masterCurrent'), passwordProps('managePassword', { required: true })))),
                h('div', { className: 'dsh-lock-actions' }, button(t('import'), { type: 'submit', disabled: disabledFor('import') }))),
              state.managed.length
                ? h('ul', { className: 'dsh-lock-list' }, state.managed.map(item => h('li', { key: item.id },
                  h('span', null, item.name), button(t('remove'), { 'aria-label': t('removeNamed', { name: item.name }),
                    disabled: disabledFor('remove'), onClick: () => removePlugin(item) }))))
                : state.managedCount === 0 && h('p', { className: 'dsh-lock-hint' }, t('empty')))
            : h('p', { className: 'dsh-lock-hint' }, t('manageAfterTest')),
        ),
        busy && h('p', { role: 'status' }, t('working')),
      );
    }

    async function requestAudit(controller) {
      const expires = window.setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(AUDIT_API, {
          method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Audit request rejected');
        const result = await response.json();
        if (result?.ok !== true || !Array.isArray(result.entries) || typeof result.durable !== 'boolean') {
          throw new Error('Invalid audit response');
        }
        const isTimestamp = at => Number.isSafeInteger(at) && at >= 0 && at <= 8.64e15;
        const entries = [];
        for (const row of result.entries.slice(0, AUDIT_LIMIT)) {
          if (!AUDIT_KINDS.has(row?.kind) || !isTimestamp(row.at)) continue;
          const { kind, at, scheduledAt } = row;
          entries.push({ kind, at, ...((kind === 'locked_schedule' || kind === 'screen_locked_schedule')
            && isTimestamp(scheduledAt) && { scheduledAt }) });
        }
        return { entries, durable: result.durable };
      } finally {
        window.clearTimeout(expires);
      }
    }

    function AuditHistory({ t, locale }) {
      const [open, setOpen] = useState(false);
      return h('details', { className: 'dsh-lock-audit', onToggle: event => setOpen(event.currentTarget.open) },
        h('summary', null, t('auditTitle')),
        open && h(AuditContents, { t, locale }));
    }

    function AuditContents({ t, locale }) {
      const [revision, setRevision] = useState(0);
      const [result, setResult] = useState(null);
      const loaded = result?.revision === revision;
      useEffect(() => {
        const controller = new AbortController();
        let active = true;
        requestAudit(controller).then(data => {
          if (active) setResult({ revision, data });
        }).catch(() => {
          if (active) setResult({ revision });
        });
        return () => {
          active = false;
          controller.abort();
        };
      }, [revision]);

      const data = loaded ? result.data : undefined;
      const formatter = new Intl.DateTimeFormat(locale.getSnapshot().active, { dateStyle: 'medium', timeStyle: 'medium' });
      const formatTime = at => formatter.format(at);
      return h('div', { className: 'dsh-lock-stack dsh-lock-audit-body' },
        h('p', { className: 'dsh-lock-hint' }, t('auditHint')),
        h('div', { className: 'dsh-lock-actions' }, button(t('auditRefresh'), {
          'aria-disabled': !loaded || undefined,
          onClick: () => { if (loaded) setRevision(current => current + 1); },
        })),
        !loaded && h('p', { role: 'status', className: 'dsh-lock-hint' }, t('auditLoading')),
        loaded && !data && h('p', { role: 'alert', className: 'dsh-lock-error' }, t('auditUnavailable')),
        data && !data.durable && h('p', { role: 'status', className: 'dsh-lock-hint' }, t('auditTemporary')),
        data && data.entries.length === 0 && h('p', { role: 'status', className: 'dsh-lock-hint' }, t('auditEmpty')),
        data && data.entries.length > 0 && h('div', { className: 'dsh-lock-audit-list', role: 'region',
          'aria-label': t('auditTitle'), tabIndex: 0 },
          h('ol', { role: 'list' }, data.entries.map(({ kind, at, scheduledAt }, index) => h('li', { key: `${at}-${kind}-${index}` },
            h('div', null, t(`audit_${kind}`)),
            h('time', { dateTime: new Date(at).toISOString(), className: 'dsh-lock-hint dsh-lock-audit-time' }, formatTime(at)),
            scheduledAt !== undefined && h('div', { className: 'dsh-lock-hint dsh-lock-audit-time' },
              t('auditScheduledFor', { time: formatTime(scheduledAt) })),
          )))));
    }

    function RecoveryNotice({ t, service, issue, title = false }) {
      const storage = issue === 'storage';
      return h('div', { className: 'dsh-lock-stack' },
        title && storage && h('strong', null, t('storageTitle')),
        h('p', { role: 'alert' }, t(storage ? 'storageRecovery' : 'unavailable')),
        h('div', { className: 'dsh-lock-actions' }, button(t('retry'), { onClick: service.refresh })),
      );
    }

    function SettingsPage({ t, locale, service, compact = false }) {
      const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
      const editable = snapshot.state && (snapshot.mode === 'setup' || snapshot.mode === 'unlocked');
      let content;
      if (editable) content = h(SettingsEditor, { t, locale, service, snapshot, compact });
      else if (snapshot.mode === 'error' && snapshot.issue === 'storage') {
        content = h(RecoveryNotice, { t, service, issue: 'storage', title: true });
      } else if (snapshot.mode === 'locked' || snapshot.mode === 'error') content = h('p', null, t('blocked'));
      else if (snapshot.status === 'loading') content = h('p', { role: 'status' }, t('loading'));
      else content = h(RecoveryNotice, { t, service });
      return h('div', { className: 'dsh-lock-page' }, !compact && h('style', null, styles),
        !compact && h('h2', null, t('title')), !compact && h(AuditHistory, { t, locale }), content);
    }

    function SetupDialog({ t, locale, service, close }) {
      const ref = useRef(null);
      const headingId = useId();
      const descriptionId = useId();
      useLayoutEffect(() => {
        const dialog = ref.current;
        const previous = document.activeElement;
        dialog.showModal();
        return () => {
          dialog.close();
          if (previous?.isConnected && previous instanceof HTMLElement) previous.focus({ preventScroll: true });
        };
      }, []);
      return h('dialog', { className: 'dsh-lock-dialog dsh-lock-setup-dialog', ref, 'aria-labelledby': headingId,
        'aria-describedby': descriptionId, onCancel: event => { event.preventDefault(); close(); },
        onKeyDown: event => event.stopPropagation(), onKeyUp: event => event.stopPropagation(),
      },
      h('style', null, styles),
      h('header', { className: 'dsh-lock-setup-header' },
        h('div', null, h('h2', { id: headingId }, t('configure')),
          h('p', { id: descriptionId, className: 'dsh-lock-hint' }, t('description'))),
        button(t('close'), { onClick: close })),
      h('div', { className: 'dsh-lock-setup-body' }, h(SettingsPage, { t, locale, service, compact: true })));
    }

    const OTP_LENGTH = 6;
    const EMPTY_OTP = Object.freeze(['', '', '', '', '', '']);

    function applyOtpPaste(digits, index, text) {
      const clean = String(text ?? '').replace(/\D/g, '');
      if (!clean) return { digits, focusIndex: index };
      const start = clean.length >= OTP_LENGTH ? 0 : index;
      const next = [...digits];
      let pos = start;
      for (const ch of clean.slice(0, OTP_LENGTH - start)) next[pos++] = ch;
      return { digits: next, focusIndex: Math.min(pos, OTP_LENGTH - 1) };
    }

    function applyOtpChange(digits, index, rawValue) {
      const clean = String(rawValue ?? '').replace(/\D/g, '');
      if (!clean) {
        const next = [...digits];
        next[index] = '';
        return { digits: next, focusIndex: index };
      }
      if (clean.length === 1) {
        const next = [...digits];
        next[index] = clean;
        return { digits: next, focusIndex: Math.min(index + 1, OTP_LENGTH - 1) };
      }
      const current = digits[index];
      if (clean.length === 2 && current && (clean[0] === current || clean[1] === current)) {
        const next = [...digits];
        next[index] = clean[0] === current ? clean[1] : clean[0];
        return { digits: next, focusIndex: Math.min(index + 1, OTP_LENGTH - 1) };
      }
      return applyOtpPaste(digits, index, clean);
    }

    function applyOtpKey(digits, index, key) {
      if (key === 'Backspace') {
        const next = [...digits];
        if (next[index]) {
          next[index] = '';
          return { digits: next, focusIndex: index, handled: true };
        }
        if (index > 0) {
          next[index - 1] = '';
          return { digits: next, focusIndex: index - 1, handled: true };
        }
        return { digits, focusIndex: index, handled: true };
      }
      if (key === 'Delete') {
        const next = [...digits];
        next[index] = '';
        return { digits: next, focusIndex: index, handled: true };
      }
      if (key === 'ArrowLeft') return { digits, focusIndex: Math.max(0, index - 1), handled: true };
      if (key === 'ArrowRight') return { digits, focusIndex: Math.min(OTP_LENGTH - 1, index + 1), handled: true };
      if (key === 'Home') return { digits, focusIndex: 0, handled: true };
      if (key === 'End') return { digits, focusIndex: OTP_LENGTH - 1, handled: true };
      return { digits, focusIndex: index, handled: false };
    }

    function StillpointEmblem() {
      return h('div', { className: 'dsh-lock-emblem', 'aria-hidden': 'true' },
        h('svg', { viewBox: '0 0 36 36', focusable: 'false', 'aria-hidden': 'true' },
          h('path', { d: 'M12.5 16v-3a5.5 5.5 0 0 1 11 0v3', fill: 'none', stroke: '#bae6fd', strokeWidth: '2.5', strokeLinecap: 'round' }),
          h('rect', { x: '9.5', y: '15', width: '17', height: '13.5', rx: '3', fill: '#e0f2fe' }),
          h('path', { d: 'M18 20v3.8', fill: 'none', stroke: '#164e63', strokeWidth: '2.5', strokeLinecap: 'round' })));
    }

    function LockGateChrome({ t, badgeKey, tone }) {
      return h('header', { className: 'dsh-lock-chrome' },
        h('div', { className: 'dsh-lock-chrome-left' },
          h('span', { className: 'dsh-lock-dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
          h('span', { className: 'dsh-lock-chrome-title' }, t('lockedWindow'))),
        h('span', { className: 'dsh-lock-pill', 'data-tone': tone || undefined }, t(badgeKey)));
    }

    function LockDialog({ t, locale, service, snapshot }) {
      const dialogRef = useRef(null);
      const passwordRef = useRef(null);
      const otpRefs = useRef([]);
      const headingId = useId();
      const descriptionId = useId();
      const passwordId = useId();
      const otpLabelId = useId();
      const [digits, setDigits] = useState(EMPTY_OTP);
      const feedback = useFeedback(t, locale);
      const active = useRef(true);
      const focusCode = useRef(false);
      const focusPassword = useRef(false);
      const busy = snapshot.pending !== null;

      useLayoutEffect(() => {
        const dialog = dialogRef.current;
        const previous = document.activeElement;
        dialog.showModal();
        return () => {
          dialog.close();
          if (previous?.isConnected && previous instanceof HTMLElement) previous.focus({ preventScroll: true });
        };
      }, []);
      useLayoutEffect(() => {
        passwordRef.current?.focus();
      }, []);
      useLayoutEffect(() => {
        if (busy) return;
        if (focusCode.current) {
          focusCode.current = false;
          otpRefs.current[0]?.focus();
        } else if (focusPassword.current) {
          focusPassword.current = false;
          passwordRef.current?.focus();
        }
      });
      useEffect(() => {
        active.current = true;
        return () => {
          active.current = false;
          if (passwordRef.current) passwordRef.current.value = '';
          for (const el of otpRefs.current) if (el) el.value = '';
        };
      }, []);

      function focusSlot(index) {
        const cell = otpRefs.current[index];
        cell?.focus();
        cell?.select?.();
      }

      function onDigitChange(index, event) {
        const next = applyOtpChange(digits, index, event.target.value);
        setDigits(next.digits);
        if (next.focusIndex !== index || event.target.value.length > 1) focusSlot(next.focusIndex);
      }

      function onDigitPaste(index, event) {
        event.preventDefault();
        const next = applyOtpPaste(digits, index, event.clipboardData?.getData('text') ?? '');
        setDigits(next.digits);
        focusSlot(next.focusIndex);
      }

      function onDigitKeyDown(index, event) {
        const next = applyOtpKey(digits, index, event.key);
        if (!next.handled) return;
        event.preventDefault();
        if (next.digits !== digits) setDigits(next.digits);
        if (next.focusIndex !== index) focusSlot(next.focusIndex);
      }

      function onPasswordKeyDown(event) {
        if (event.key !== 'Enter') return;
        if (digits.every(digit => digit === '')) {
          event.preventDefault();
          if (!feedback.coolingDown('send')) void send();
        }
      }

      async function send() {
        if (busy) return;
        const input = passwordRef.current;
        if (!input?.reportValidity()) return;
        const masterPassword = input.value;
        feedback.clear();
        const result = await service.post('send', { masterPassword });
        if (!active.current) return;
        if (result?.ok) {
          setDigits(EMPTY_OTP);
          focusCode.current = true;
        } else {
          input.value = '';
          focusPassword.current = true;
        }
        feedback.result(result, 'send', 'codeSent');
      }

      async function unlock(event) {
        event.preventDefault();
        if (busy) return;
        const input = passwordRef.current;
        if (!input?.reportValidity()) return;
        const emptySlot = digits.findIndex(digit => !/^\d$/.test(digit));
        if (emptySlot !== -1) {
          otpRefs.current[emptySlot]?.focus();
          otpRefs.current[emptySlot]?.reportValidity?.();
          return;
        }
        const masterPassword = input.value;
        const code = digits.join('');
        input.value = '';
        setDigits(EMPTY_OTP);
        feedback.clear();
        const result = await service.post('unlock', { code, masterPassword });
        if (!active.current) return;
        if (!result?.ok) {
          if (result?.retryAt && passwordRef.current) passwordRef.current.value = '';
          focusPassword.current = true;
        }
        feedback.result(result, 'unlock');
      }

      return h('dialog', { className: 'dsh-lock-dialog dsh-lock-gate-dialog', ref: dialogRef, 'aria-modal': true,
        'aria-labelledby': headingId, 'aria-describedby': descriptionId,
        onCancel: event => event.preventDefault(),
        onKeyDown: event => event.stopPropagation(),
        onKeyUp: event => event.stopPropagation(),
      },
      h('style', null, styles),
      h(LockGateChrome, {
        t,
        badgeKey: snapshot.draining ? 'lockBadgeDraining' : 'lockBadgeLocked',
        tone: snapshot.draining ? 'draining' : undefined,
      }),
      h('div', { className: 'dsh-lock-gate-body' },
        h('div', { className: 'dsh-lock-hero' },
          h(StillpointEmblem),
          h('div', { className: 'dsh-lock-hero-copy' },
            h('h2', { id: headingId }, t('lockedTitle')),
            h('p', { id: descriptionId, className: 'dsh-lock-subtitle' }, t('lockedDescription')))),
        snapshot.draining && h('div', { className: 'dsh-lock-drain-card', role: 'status' },
          h('div', { className: 'dsh-lock-drain-head' },
            h('span', { className: 'dsh-lock-drain-title' },
              h('span', { className: 'dsh-lock-drain-dot', 'aria-hidden': 'true' }),
              t('lockedDrainingTitle')),
            h('span', { className: 'dsh-lock-pill', 'data-tone': 'draining' }, t('lockedDrainingBadge'))),
          h('p', { className: 'dsh-lock-drain-copy' }, t('lockedDraining')),
          h('div', { className: 'dsh-lock-drain-bar', 'aria-hidden': 'true' }, h('span'))),
        h('form', { className: 'dsh-lock-stack', onSubmit: unlock, noValidate: true, autoComplete: 'off', 'aria-busy': busy || undefined },
          h('fieldset', { disabled: busy }, h('div', { className: 'dsh-lock-stack' },
            h('div', { className: 'dsh-lock-group' },
              h('div', { className: 'dsh-lock-label-row' },
                h('label', { className: 'dsh-lock-label-main', htmlFor: passwordId }, t('master')),
                h('span', { className: 'dsh-lock-label-spec', 'aria-hidden': 'true' }, t('lockedVaultSpec'))),
              h('div', { className: 'dsh-lock-pass-shell', onClick: event => {
                if (event.target === event.currentTarget) passwordRef.current?.focus();
              } },
                h('input', passwordProps('masterPassword', {
                  id: passwordId,
                  ref: passwordRef,
                  className: 'dsh-lock-gate-input',
                  placeholder: t('masterPlaceholder'),
                  required: true,
                  autoCorrect: 'off',
                  autoCapitalize: 'off',
                  'data-1p-ignore': 'true',
                  'data-lpignore': 'true',
                  'data-bwignore': 'true',
                  'data-form-type': 'other',
                  onKeyDown: onPasswordKeyDown,
                })),
                h('button', {
                  type: 'button',
                  className: 'dsh-lock-pass-send',
                  disabled: feedback.coolingDown('send'),
                  onClick: send,
                }, snapshot.pending === 'send' ? t('sendingCode') : t('send')))),
            h('div', { className: 'dsh-lock-group' },
              h('div', { className: 'dsh-lock-label-row' },
                h('span', { id: otpLabelId, className: 'dsh-lock-label-main' }, t('code')),
                h('span', { className: 'dsh-lock-label-spec', 'aria-hidden': 'true' }, t('codeSpec'))),
              h('div', { className: 'dsh-lock-otp-row' },
                h('div', { className: 'dsh-lock-otp-grid', role: 'group', 'aria-labelledby': otpLabelId },
                  digits.map((digit, index) => h('input', {
                    key: index,
                    ref: node => { otpRefs.current[index] = node; },
                    type: 'text',
                    className: 'dsh-lock-otp-cell',
                    value: digit,
                    'data-filled': digit ? '' : undefined,
                    required: true,
                    inputMode: 'numeric',
                    pattern: '[0-9]',
                    maxLength: OTP_LENGTH,
                    spellCheck: false,
                    autoComplete: index === 0 ? 'one-time-code' : 'off',
                    'data-1p-ignore': 'true',
                    'data-lpignore': 'true',
                    'data-bwignore': 'true',
                    'data-form-type': 'other',
                    'aria-label': t('codeDigit', { index: index + 1, total: OTP_LENGTH }),
                    onChange: event => onDigitChange(index, event),
                    onPaste: event => onDigitPaste(index, event),
                    onKeyDown: event => onDigitKeyDown(index, event),
                    onFocus: event => event.target.select?.(),
                  }))),
                h('button', {
                  type: 'submit',
                  className: 'dsh-lock-gate-btn',
                  disabled: feedback.coolingDown('unlock'),
                }, snapshot.pending === 'unlock' ? t('unlockingVault') : t('unlockLocked'))))))),
        snapshot.status === 'loading' && h('p', { role: 'status', className: 'dsh-lock-gate-note' }, t('lockConnecting')),
        snapshot.status === 'unavailable' && h('div', { className: 'dsh-lock-stack' },
          h('p', { role: 'alert', className: 'dsh-lock-gate-note', 'data-tone': 'alert' }, t('lockDisconnected')),
          h('div', { className: 'dsh-lock-actions' },
            h('button', { type: 'button', className: 'dsh-lock-gate-btn dsh-lock-gate-btn-secondary', onClick: service.refresh, disabled: busy }, t('retry')))),
        busy && h('p', { role: 'status', className: 'dsh-lock-gate-note' }, t('working')),
        feedback.node,
      ),
      h('footer', { className: 'dsh-lock-gate-footer' }, t('lockedFooter')));
    }

    function CleanupDialog({ t, service, issue, snapshot }) {
      const ref = useRef(null);
      const retryRef = useRef(null);
      const title = useId();
      const descriptionId = useId();
      const [checking, setChecking] = useState(false);
      const busy = checking || snapshot?.status === 'loading';
      useLayoutEffect(() => {
        const dialog = ref.current;
        const previous = document.activeElement;
        dialog.showModal();
        retryRef.current?.focus();
        return () => {
          dialog.close();
          if (previous?.isConnected && previous instanceof HTMLElement) previous.focus({ preventScroll: true });
        };
      }, []);
      async function retry() {
        if (busy) return;
        setChecking(true);
        try {
          await service.refresh();
        } finally {
          setChecking(false);
        }
      }
      return h('dialog', { className: 'dsh-lock-dialog dsh-lock-gate-dialog', ref, 'aria-modal': true,
        'aria-labelledby': title, 'aria-describedby': descriptionId,
        onCancel: event => event.preventDefault(),
        onKeyDown: event => event.stopPropagation(), onKeyUp: event => event.stopPropagation(),
      },
      h('style', null, styles),
      h(LockGateChrome, { t, badgeKey: 'lockBadgeAlert', tone: 'alert' }),
      h('div', { className: 'dsh-lock-gate-body' },
        h('div', { className: 'dsh-lock-hero' },
          h(StillpointEmblem),
          h('div', { className: 'dsh-lock-hero-copy' },
            h('h2', { id: title }, t(issue === 'cleanup' ? 'cleanupTitle' : 'lockedTitle')))),
        h('p', { id: descriptionId, role: 'alert', className: 'dsh-lock-gate-note', 'data-tone': 'alert' },
          t(issue === 'cleanup' ? 'cleanupRecovery' : 'lockError')),
        busy && h('p', { role: 'status', className: 'dsh-lock-gate-note' }, t('checking')),
        h('div', { className: 'dsh-lock-actions' },
          h('button', { ref: retryRef, type: 'button', className: 'dsh-lock-gate-btn dsh-lock-gate-btn-secondary',
            disabled: busy, onClick: retry }, t('retry')))),
      h('footer', { className: 'dsh-lock-gate-footer' }, t('lockedFooter')));
    }

    function Overlay({ t, locale, service }) {
      const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
      const [dismissed, setDismissed] = useState(false);
      const [setupOpen, setSetupOpen] = useState(false);
      const { mode, issue, smtpConfigured } = snapshot;
      useEffect(() => {
        if (mode === 'locked' || mode === 'error') setSetupOpen(false);
      }, [mode]);
      if (mode === 'locked') return h(LockDialog, { t, locale, service, snapshot });
      if (mode === 'error') {
        if (issue !== 'storage') return h(CleanupDialog, { t, service, issue, snapshot });
        return h('aside', { className: 'dsh-lock-card dsh-lock-notice' }, h('style', null, styles),
          h(RecoveryNotice, { t, service, issue, title: true }));
      }
      return h(React.Fragment, null,
        mode === 'setup' && !dismissed && h('aside', { className: 'dsh-lock-card dsh-lock-notice' },
          h('style', null, styles),
          h('p', { role: 'status' }, t(smtpConfigured ? 'testPrompt' : 'setupPrompt')),
          h('div', { className: 'dsh-lock-actions' },
            button(t('configure'), { primary: true, onClick: () => setSetupOpen(true) }),
            button(t('dismiss'), { onClick: () => setDismissed(true) }))),
        setupOpen && h(SetupDialog, { t, locale, service, close: () => setSetupOpen(false) }),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const service = createLockService();
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-lock-gate: dictionaries');
        ctx.effect(service.activate, 'dsh-lock-gate: lock-state polling');
        const t = ctx.locale.bind(NS);
        const inject = () => ({ service, locale: ctx.locale });
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-lock-gate', locale: NS, inject,
        }, Overlay));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-lock-gate', order: 50, label: () => t('title'), locale: NS, inject,
        }, SettingsPage));
      },
    };
  },
});
