import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { toTaiwanTraditional } from '../extension/taiwan-text.js';

test('fixes the real mixed-script dataset regression without rewriting meaning', () => {
  const source = '該團隊上週發布的模型所使用的数据集比前一版小，但並非所有任务都更准确。';
  assert.equal(toTaiwanTraditional(source), '該團隊上週發布的模型所使用的資料集比前一版小，但並非所有任務都更準確。');
  assert.equal(source, '該團隊上週發布的模型所使用的数据集比前一版小，但並非所有任务都更准确。');
});

test('converts both Simplified and non-Taiwan Traditional phrases', () => {
  const expected = '軟體、伺服器、網路、記憶體、影片、使用者、資訊、印表機、資料集。';
  assert.equal(toTaiwanTraditional('软件、服务器、网络、内存、视频、用户、信息、打印机、数据集。'), expected);
  assert.equal(toTaiwanTraditional('軟件、服務器、網絡、內存、視頻、用戶、信息、打印機、數據集。'), expected);
  assert.equal(toTaiwanTraditional('视频会议和視頻通話。'), '視訊會議和視訊通話。');
});

test('uses 品質 only for specific quality collocations and keeps physical mass', () => {
  assert.equal(
    toTaiwanTraditional('软件质量、服務質量、产品质量、翻譯質量。粒子质量为 5 kg，质量守恒；质量中心保持不变。'),
    '軟體品質、服務品質、產品質量、翻譯品質。粒子質量為 5 kg，質量守恆；質量中心保持不變。',
  );
  assert.equal(toTaiwanTraditional('物理學的質量與重量不同。'), '物理學的質量與重量不同。');
  assert.equal(toTaiwanTraditional('产品质量是一千克，物理质量守恒。'), '產品質量是一千克，物理質量守恆。');
});

test('keeps existing Taiwan prose, numbers, dates, and negation', () => {
  const source = '請開啟帳戶中的設定，並下載檔案。2026-05-12 前取消不會刪除資料，5 月 13 日後不符合退款資格。價格為 $19.99，幅度並非微不足道。';
  assert.equal(toTaiwanTraditional(source), source);
  assert.equal(toTaiwanTraditional('一出來就能看到萬里長城，請登入帳號。'), '一出來就能看到萬里長城，請登入帳號。');
  assert.equal(toTaiwanTraditional('软件更新了，一出來就能看到萬里長城。'), '軟體更新了，一出來就能看到萬里長城。');
  assert.equal(toTaiwanTraditional('登录账号，使用賬號。'), '登入帳號，使用帳號。');
  assert.equal(toTaiwanTraditional('截止日期从 3 月 15 日改到 5 月 13 日；不会删除 1,234 笔数据。'), '截止日期從 3 月 15 日改到 5 月 13 日；不會刪除 1,234 筆資料。');
});

test('keeps correct Taiwan terms that upstream short phrases would expand again', () => {
  const source = '數據機、運算子、真實模式、腦梗塞、史他汀。';
  assert.equal(toTaiwanTraditional(source), source);
  for (const [input, expected] of [
    ['調製解調器', '數據機'],
    ['運算符', '運算子'],
    ['實模式', '真實模式'],
    ['腦梗死', '腦梗塞'],
    ['他汀類', '史他汀類'],
    ['類模板', '類別範本'],
  ]) {
    assert.equal(toTaiwanTraditional(input), expected);
    assert.equal(toTaiwanTraditional(expected), expected);
  }
});

test('preserves literal Chinese URLs, query parameters and email addresses', () => {
  const literals = [
    'https://example.com/软件?q=用户&数据=信息#网络',
    'http://example.com/数据集',
    'ftp://example.com/视频.txt',
    'mailto:用户@example.com?subject=软件质量',
    'support+用户@example.com',
    'https://example.com/a(软件)',
    'https://example.com/软件/（数据）',
  ];
  for (const literal of literals) {
    assert.equal(toTaiwanTraditional(`软件 ${literal} 信息。`), `軟體 ${literal} 資訊。`);
  }
  assert.equal(toTaiwanTraditional('软件 https://example.com/软件?q=用户，信息。'), '軟體 https://example.com/软件?q=用户，資訊。');
});

test('normalizes Chinese slash lists instead of mistaking them for paths', () => {
  assert.equal(toTaiwanTraditional('软件/硬件、数据/信息都需要更新。'), '軟體/硬體、資料/資訊都需要更新。');
  assert.equal(toTaiwanTraditional('你可以选择输入/输出的数据。'), '你可以選擇輸入/輸出的資料。');
  assert.equal(toTaiwanTraditional('请读取 /软件/用户 数据。'), '請讀取 /软件/用户 資料。');
});

test('converts Markdown labels and preserves absolute, relative, escaped and reference destinations', () => {
  assert.equal(
    toTaiwanTraditional('[软件说明](../软件/说明.md "视频信息") 和 [服务](<https://example.com/软件，用户>)。'),
    '[軟體說明](../软件/说明.md "影片資訊") 和 [服務](<https://example.com/软件，用户>)。',
  );
  assert.equal(
    toTaiwanTraditional('[用户](软件(信息)/服务) ![视频](../图片/用户.png)\n[服务]: ../软件/服务.md "视频信息"'),
    '[使用者](软件(信息)/服务) ![影片](../图片/用户.png)\n[服務]: ../软件/服务.md "影片資訊"',
  );
  assert.equal(toTaiwanTraditional('[用户](../软件\(信息\)/服务.md)'), '[使用者](../软件\(信息\)/服务.md)');
});

test('preserves backtick code and fenced blocks while converting surrounding prose', () => {
  assert.equal(toTaiwanTraditional('软件 `用户.信息 = "数据集"` 信息。'), '軟體 `用户.信息 = "数据集"` 資訊。');
  assert.equal(toTaiwanTraditional('软件 ``用户`信息`` 视频。'), '軟體 ``用户`信息`` 影片。');
  const fenced = '软件\n```javascript\nconst 用户 = "数据集";\n```\n视频。';
  assert.equal(toTaiwanTraditional(fenced), '軟體\n```javascript\nconst 用户 = "数据集";\n```\n影片。');
  assert.equal(toTaiwanTraditional('软件\n~~~\n用户 数据集\n~~~\n视频。'), '軟體\n~~~\n用户 数据集\n~~~\n影片。');
  assert.equal(toTaiwanTraditional('软件\n```\n用户 数据集'), '軟體\n```\n用户 数据集');
});

test('preserves common paths, filenames, and explicit technical identifiers', () => {
  const literals = [
    '/Users/用户/软件/说明.txt',
    '~/软件/用户.json',
    './软件/用户.json',
    '../软件/用户.json',
    'C:\\软件\\用户\\说明.txt',
    'C:/软件/用户/说明.txt',
    'docs/软件/用户.md',
    '软件.json',
    '用户_信息',
    'config.用户',
    '$用户',
  ];
  for (const literal of literals) {
    assert.equal(toTaiwanTraditional(`软件 ${literal} 视频。`), `軟體 ${literal} 影片。`);
  }
});

test('does not interpret HTML, invent sentinel tokens, or alter empty / non-Chinese input', () => {
  assert.equal(toTaiwanTraditional('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  assert.equal(toTaiwanTraditional('BT_PLACEHOLDER_0 软件 \uE000 用户 \uE001 __TOKEN_0__'), 'BT_PLACEHOLDER_0 軟體 \uE000 使用者 \uE001 __TOKEN_0__');
  for (const text of ['', '  \n\t', 'Gemini 3.5 Flash Lite — 2026-05-12 / $0.00', '👩🏽‍💻 😊']) assert.equal(toTaiwanTraditional(text), text);
  assert.throws(() => toTaiwanTraditional(null), TypeError);
});

test('conversion is deterministic and idempotent for protected and converted text', () => {
  const samples = [
    '該團隊所使用的数据集和软件质量。',
    '软件、服务器、网络、内存、视频、用户、信息、打印机。',
    '请下载软件 https://example.com/软件?q=用户，信息不会删除。',
    '[用户](../软件/用户.md) `软件质量` 粒子质量守恒。',
    '软件\n```\nconst 用户 = "数据集";\n```\n视频会议。',
    'BT_PLACEHOLDER_0 软件 \uE000 用户 \uE001 __TOKEN_0__',
    '一出來就能看到萬里長城，請登入帳號。',
    '软件更新了，一出來就能看到萬里長城。',
  ];
  for (const source of samples) {
    const once = toTaiwanTraditional(source);
    assert.equal(toTaiwanTraditional(source), once);
    assert.equal(toTaiwanTraditional(once), once);
  }
});

test('vendors only the pinned module with its upstream license notices', () => {
  const root = new URL('../extension/vendor/opencc-js/', import.meta.url);
  const module = readFileSync(new URL('cn2t.js', root));
  assert.equal(createHash('sha512').update(module).digest('hex'), '6deb54adbc38ef3b2f13d1773899c81811f54c7beaf67853371779f5b51c196aab7a49e9b4b90d869dbf436dd497f3adf55622a2840d77abc8cbcd72384a1ea7');
  assert.match(readFileSync(new URL('LICENSE', root), 'utf8'), /MIT License/);
  assert.match(readFileSync(new URL('LICENSES/Apache-2.0.txt', root), 'utf8'), /Apache License/);
  assert.match(readFileSync(new URL('THIRD_PARTY_LICENSES.md', root), 'utf8'), /opencc-data/);
  assert.match(readFileSync(new URL('README.md', root), 'utf8'), /opencc-js 1\.4\.2/);
});
