/* Reading-prototype compositions, checked against the source pages in sources/.
   Course identities, ratings and relationships come from the generated CLI export.
   These compositions are not a second editable course database. */
(() => {
  const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const m = s => `<span class="math" data-math="${esc(s)}"></span>`;
  const box = (tone, content) => `<div class="frame tint-${tone} ${tone==='blue'?'condition-box':tone==='green'?'conclusion-box':'reminder-box'}"><div class="frame-content">${content}</div></div>`;
  const material = (id, title, tag, content) => `<details class="material" id="${id}"><summary>${title}<span class="material-tag">${tag}</span></summary><div class="material-content">${content}</div></details>`;
  const practice = (id, question, hint, answer, provenance) => `<p>${question}</p><p class="small-copy">${provenance}</p><div class="reveal-actions"><button data-reveal="${id}-hint" aria-expanded="false">看提示</button><button data-reveal="${id}-answer" aria-expanded="false">看答案与步骤</button></div><div id="${id}-hint" class="hint" hidden>${hint}</div><div id="${id}-answer" class="answer" hidden>${answer}</div>`;
  const note = id => material(`${id}-note`, '给自己的提醒', '个人笔记', `<div class="frame tint-amber reminder-box"><textarea class="unit-note" aria-label="${id}个人笔记" placeholder="记下你容易混淆的地方……"></textarea></div>`);
  const bit = (scope, key, label, value) => `<button class="bit-control" data-bit-scope="${scope}" data-bit="${key}" aria-label="切换${label.replaceAll(/<[^>]+>/g,'')}" aria-pressed="${!!value}"><span>${label}</span><b>${value}</b></button>`;

  window.READING_CONTENT = {
    'KU-055': {
      title: 'MUX：选择端与输出',
      body: `<p class="lead">复用器（MUX）根据选择端的取值，将一路数据送到输出端。对于 4 选 1 MUX，<span class="blue-text">${m('S_1')} 是选择码的高位，${m('S_0')} 是低位。</span></p>
      ${box('blue',`<p>2 选 1 MUX 用 S 选择输入：S=0 时输出 I₀，S=1 时输出 I₁。</p><div class="math-row">${m('Y=\u005coverline{S}I_0+SI_1')}</div><p>4 选 1 MUX 中，选择码 00、01、10、11 依次选中 ${m('I_0')}、${m('I_1')}、${m('I_2')}、${m('I_3')}。对应的输出公式如下。</p>`)}
      <div class="math-row blue-text">${m('Y=\u005coverline{S_1}\u005coverline{S_0}I_0+\u005coverline{S_1}S_0I_1+S_1\u005coverline{S_0}I_2+S_1S_0I_3')}</div>
      <p>下图的数据端连接为 ${m('I_0=z,\ I_1=\u005coverline z,\ I_2=0,\ I_3=1')}。其中 z 是可切换的输入变量。先用选择码找到对应通道，再沿绿色路径读出输出。</p>
      <div class="diagram-wrap"><svg class="diagram" data-diagram="mux" viewBox="0 0 510 310" aria-label="4选1复用器，选择端控制输入通道"></svg></div>
      <div class="row-controls"><span>点击切换电平</span>${bit('mux','s1','S₁',0)}${bit('mux','s0','S₀',1)}${bit('mux','z','z',0)}</div>
      ${box('green',`<span id="mux-result" aria-live="polite"></span>`)}
      ${material('mux-why','例题 · 选择码为 01 时的输出','完整讲解',`<p>沿用上图接线，求 ${m('S_1S_0=01')} 时的输出。</p><ol class="steps"><li>通道从 0 开始编号，选择码按普通二进制 <strong>00、01、10、11</strong> 排列，与卡诺图使用的格雷顺序不同。</li><li>把选择码 01 代入输出公式，四项的选择系数依次为 0、1、0、0，因此只剩 ${m('Y=I_1')}。</li><li>I₁ 接的是 z 的反相信号，分别代入 z=0 和 z=1，即可得到输出。</li></ol>${box('green',`${m('Y=I_1=\u005coverline z')}。当 z=0 时，输出为 1；当 z=1 时，输出为 0。`)}<p class="small-copy">按课件 05 第 11 页选择公式构造的验证示例。</p>`)}
      ${material('mux-check','练习 · 换一个选择码','先自行判断',practice('mux-check',`保持上面的接线，令 ${m('S_1S_0=10')}，分别取 z=0 和 z=1，输出是否变化？`,'先根据选择码确定通道，再看该数据端接的是变量还是固定电平。',`10 选中 ${m('I_2')}，而 ${m('I_2=0')}，所以两次输出都为 0。未选中数据端的变化不影响当前输出。`,'依据课件选择规则编制的自测。'))}
      ${note('mux')}`,
      sources: ['c05-p04.png','c05-p11.png']
    },
    'KU-056': {
      title: '用 MUX 实现逻辑函数',
      body: `<p class="lead">用 4 选 1 MUX 实现三变量函数时，先选两个变量接到选择端。每个选择码对应一个数据端，接什么信号由剩下的变量决定。</p>
      <ol class="steps"><li>固定 ${m('S_1=A,\ S_0=B')}，按 AB=00、01、10、11 将输入组合分成四组，依次对应 I₀、I₁、I₂、I₃。</li><li>在每一组中，分别求 C=0、C=1 时的函数值，将这两个值按顺序记为一对。</li><li>对照下表，将每组的数据端接为 0、C、${m('\u005coverline C')} 或 1。</li></ol>
      <table class="reading-table"><thead><tr><th>C=0 时 F</th><th>C=1 时 F</th><th>数据端连接</th></tr></thead><tbody><tr><td>0</td><td>0</td><td class="blue-cell">0</td></tr><tr><td>0</td><td>1</td><td class="blue-cell">C</td></tr><tr><td>1</td><td>0</td><td class="blue-cell">${m('\u005coverline C')}</td></tr><tr><td>1</td><td>1</td><td class="blue-cell">1</td></tr></tbody></table>
      ${box('amber','每对输出值都按 C=0、C=1 的顺序读取。如果改用其他变量作选择端，需要重新分组，再按剩余变量取 0、取 1 的顺序求值。')}
      ${material('mux-method-example','例题 · 确定四个数据端的连接','课件 05 · P17–18',`<p>实现 ${m('Y=A\u005coverline B+\u005coverline B\u005coverline C+\u005coverline A BC')}。</p><p><strong>1. 确定选择端。</strong>令 ${m('S_1=A,S_0=B')}，按 AB=00、01、10、11 分组。</p><p><strong>2. 求每组的输出值。</strong>依次代入 C=0、C=1。</p><p>以 AB=01 为例，前两项均为 0，只有第三项 ${m('\u005coverline A BC')} 决定输出，因此该组在 C=0、C=1 时的输出依次为 0、1，数据端应接 C。</p><table class="reading-table"><thead><tr><th>AB</th><th>C=0</th><th>C=1</th><th>数据端</th></tr></thead><tbody><tr><td>00</td><td>1</td><td>0</td><td>${m('I_0=\u005coverline C')}</td></tr><tr><td>01</td><td>0</td><td>1</td><td>${m('I_1=C')}</td></tr><tr><td>10</td><td>1</td><td>1</td><td>${m('I_2=1')}</td></tr><tr><td>11</td><td>0</td><td>0</td><td>${m('I_3=0')}</td></tr></tbody></table><p><strong>3. 按表连接数据端。</strong>表中的四行依次对应 I₀、I₁、I₂、I₃。</p>${box('green',`把 ${m('\u005coverline C,C,1,0')} 依次接到四个数据端，MUX 的输出就实现了原函数。`)}`)}
      ${material('mux-method-practice','练习 · 用 4 选 1 实现最小项函数','作业第 3 题(b)',practice('mux-method',`实现 ${m('L(A,B,C)=\u005cSigma m(1,2,6,7)')}。固定 ${m('S_1=A,S_0=B')}，求 ${m('I_0,I_1,I_2,I_3')}。`,'把最小项编号写成 ABC 的二进制形式，先按 AB 分组，再依次读取 C=0、C=1 时的函数值。',`<p><strong>1. 按 AB 分组。</strong>每组包含 C=0、C=1 两个输入组合，编号在下表中依次列出。</p><p><strong>2. 读取函数值并确定连接。</strong>题目列出的最小项取 1，其余取 0；再按输出对确定该数据端接什么。</p><table class="reading-table"><thead><tr><th>AB</th><th>最小项编号</th><th>输出对</th><th>连接</th></tr></thead><tbody><tr><td>00</td><td>0、1</td><td>01</td><td>${m('I_0=C')}</td></tr><tr><td>01</td><td>2、3</td><td>10</td><td>${m('I_1=\u005coverline C')}</td></tr><tr><td>10</td><td>4、5</td><td>00</td><td>${m('I_2=0')}</td></tr><tr><td>11</td><td>6、7</td><td>11</td><td>${m('I_3=1')}</td></tr></tbody></table><p><strong>3. 复核连接。</strong>将 C=0、C=1 分别代回各组，检查全部 8 个输入组合的输出是否与题目一致。</p>`,'Q-092 · 组合模块 1 作业 PDF 第 3 页。答案据题干推导。'))}
      ${note('mux-method')}`,
      sources: ['c05-p17.png','c05-p18.png','hw05-p03.png']
    },
    'KU-035': {
      title: '卡诺图：相邻项的合并',
      body: `<p class="lead">卡诺图通过合并相邻的 1 来化简逻辑函数。填图前，先确认坐标按格雷码排列：两位坐标的顺序为 <span class="blue-text">00、01、11、10</span>，首尾也相邻。</p>
      <div class="diagram-wrap"><svg class="diagram" data-diagram="kmap" viewBox="0 0 540 360" aria-label="四变量卡诺图，行列采用格雷顺序，格内为最小项编号"></svg></div><p>图中数字是最小项编号。相邻格可以跨越左右或上下边界，斜对角不算相邻。</p><div class="row-controls"><button class="inline-action" id="kmap-corners" aria-pressed="false">看看四角为什么相邻</button><span id="kmap-corner-copy" class="green-text">格内数字是最小项编号</span></div>
      <ol class="steps"><li>按真值表填入 0、1。</li><li>将相邻的 1 圈成含 ${m('2^k')} 格的矩形，圈组可以跨边界，也可以重叠。</li><li>检查所有 1 是否都被覆盖，每个圈内都不能含有 0。</li><li>每圈只保留取值不变的变量，消去取值变化的变量，再将各圈得到的项相或。</li></ol>
      ${box('amber','圈越大，能消去的变量越多，但不能只按圈的大小决定。若某个 1 只能由一个不能再扩大的圈覆盖，就必须保留这个圈（必要质蕴含）；然后用尽量简洁的组合覆盖剩余的 1。')}
      ${material('kmap-example','例题 · 跨边界的四格合并','习题课【5】①',`<p>化简 ${m('F=\u005coverline{AC+\u005coverline A BC+\u005coverline B C}+AB\u005coverline C')}。</p><p><strong>1. 填写卡诺图。</strong>列 BC 按 00、01、11、10 排列，行 A=0、1。填图结果两行均为 1、0、0、1。</p><svg class="diagram" data-diagram="kmap-example" viewBox="0 0 650 280" aria-label="三变量卡诺图，两行首尾均为1，四格跨边合并"></svg><ol class="steps" start="2"><li>首列与末列相邻，可以跨边合为一个四格圈。</li><li>A 与 B 在圈内都变化，只有 C 始终为 0。</li><li>消去 A、B 后，保留 ${m('\u005coverline C')}。</li></ol>${box('green',m('F=\u005coverline C'))}<p class="small-copy">Q-109 · 习题课 PDF 第 9 页，结果与官方答案一致。</p>`)}
      ${material('kmap-practice','练习 · 同样的方法换一组 1','先画图再核对',practice('kmap',`三变量函数 ${m('F(A,B,C)=\u005cSigma m(1,3,5,7)')}，写出最简与或式，并说明哪两个变量被消去。`,'沿用 BC=00、01、11、10 的列顺序。四个 1 分别在哪两列？',`<ol class="steps"><li>将题目中的四个最小项填入图中，A=0、1 两行的中间两列均为 1。</li><li>将这四格合成一圈。圈内 A、B 都变化，C 恒为 1。</li><li>消去 A、B，得到 ${m('F=C')}。</li></ol>`,'依据习题课【5】①的圈组方法编制的自测变式。'))}
      ${note('kmap')}`,
      sources: ['c03-p07.png','c03-p14.png','ex07-p09.png']
    },
    'KU-063': {
      title: '74LS138：使能与地址译码',
      body: `<p class="lead">74LS138 是 3 线–8 线译码器。满足使能条件时，3 位地址选中 8 路输出中的一路，<span class="green-text">该路输出为 0</span>，其余为 1；不满足使能条件时，全部输出为 1。</p>
      <p>S₁ 为高有效使能端，<span class="overline">S₂</span>、<span class="overline">S₃</span> 为低有效使能端。三个端口的实际电平必须依次为 1、0、0，芯片才会译码。下表用 n 表示地址选中的输出编号。</p>
      <table class="reading-table"><thead><tr><th>S₁</th><th><span class="overline">S₂</span>、<span class="overline">S₃</span> 实际电平</th><th>输出规则</th></tr></thead><tbody><tr><td>0</td><td>任意</td><td>全部为 1</td></tr><tr><td>任意</td><td>至少一个为 1</td><td>全部为 1</td></tr><tr><td>1</td><td>均为 0</td><td>第 n 路为 0，其余为 1</td></tr></tbody></table>
      ${box('amber','端名上的横线和端口旁的小圆圈表示低有效。表格和按钮中的 0、1 都是引脚的实际电平，判断时不需要再次取反。')}
      ${box('blue',`<p>满足使能条件后，再按地址选择输出。地址顺序为 ${m('A_2A_1A_0')}，输出编号的计算公式为：</p><p>${m('n=4A_2+2A_1+A_0')}</p><p>${m('A_2')} 是最高位，${m('A_0')} 是最低位，n 是被选中的输出编号。</p>`)}
      <p>下图显示当前地址和使能电平。点击图下的按钮切换 0、1，再查看输出结果。</p>
      <div class="diagram-wrap"><svg class="diagram" data-diagram="decoder" viewBox="0 0 500 420" aria-label="74LS138地址端、使能端与低有效输出"></svg></div>
      <div class="row-controls"><span>点击切换地址电平</span>${bit('decoder','a2','A₂',0)}${bit('decoder','a1','A₁',0)}${bit('decoder','a0','A₀',1)}</div>
      <div class="row-controls"><span>点击切换使能端实际电平</span>${bit('decoder','s1','S₁',1)}${bit('decoder','s2','<span class="overline">S₂</span>',0)}${bit('decoder','s3','<span class="overline">S₃</span>',0)}</div>
      ${box('green',`<div id="decoder-result" aria-live="polite"></div>`)}
      ${material('decoder-table','完整功能表 · 八种地址对应的输出','功能表',`<p>使能条件满足时：</p><table class="reading-table"><thead><tr><th>A₂A₁A₀</th>${Array.from({length:8},(_,i)=>`<th><span class="overline">Y${i}</span></th>`).join('')}</tr></thead><tbody>${Array.from({length:8},(_,n)=>`<tr><td>${n.toString(2).padStart(3,'0')}</td>${Array.from({length:8},(_,i)=>`<td${i===n?' class="green-text"':''}>${i===n?0:1}</td>`).join('')}</tr>`).join('')}</tbody></table><p>不满足使能条件时，不论地址是多少，8 路输出都为 1。</p>`)}
      ${material('decoder-example','例题 · 用高 7 位地址生成片选','作业第 4 题',`<p>20 位地址总线 ${m('A_{19}\ldots A_0')} 连接 8 个外设，高 7 位按题图连接到 138 译码器的使能端和地址端。求外设 0、5、7 的低有效片选信号。</p><p class="small-copy">原题图标为 74HC138，此处使用其与 74LS138 相同的译码逻辑；使能端名按原题写为 E₁、E₂、E₃。</p><p><strong>1. 对照题图确认接线。</strong>先区分使能端和地址端，再记录各地址信号的去向。</p><table class="reading-table"><thead><tr><th>地址信号</th><th>接入芯片</th></tr></thead><tbody><tr><td>${m('A_{19},A_{18}')}</td><td>低有效 E₁、E₂</td></tr><tr><td>${m('\u005coverline{A_{17}+A_{16}}')}</td><td>高有效 E₃</td></tr><tr><td>${m('A_{15},A_{14},A_{13}')}</td><td>地址 A₂、A₁、A₀（高 → 低）</td></tr></tbody></table><p><strong>2. 写出使能条件。</strong>用 E 表示芯片允许译码的条件：${m('E=\u005coverline{A_{19}}\u005coverline{A_{18}}\u005coverline{A_{17}}\u005coverline{A_{16}}')}。</p><p><strong>3. 写出目标地址。</strong>外设编号 0、5、7 对应的 A₁₅A₁₄A₁₃ 依次为 000、101、111。</p><p><strong>4. 写出低有效片选信号。</strong>将 E 与各外设的地址条件相与，再对整个选中条件取反，得到实际片选线：</p><div><div class="math-row">${m('CS_0=\u005coverline{E\u005ccdot\u005coverline{A_{15}}\u005coverline{A_{14}}\u005coverline{A_{13}}}')}</div><div class="math-row">${m('CS_5=\u005coverline{E\u005ccdot A_{15}\u005coverline{A_{14}}A_{13}}')}</div><div class="math-row">${m('CS_7=\u005coverline{E\u005ccdot A_{15}A_{14}A_{13}}')}</div></div>${box('green','选中条件为 1 时，对应片选线的实际电平为 0。')}<p class="small-copy">Q-093 · 组合模块 1 作业 PDF 第 4 页；答案据原图推导。核对位序时，可在满足使能条件的情况下取 A₁₅A₁₄A₁₃=001，此时应选中 Y₁，而不是 Y₄。</p>`)}
      ${material('decoder-practice','练习 · 先判使能，再判地址','两种情况',practice('decoder','地址固定为 A₂A₁A₀=010。① 三个使能端实际电平为 1、0、0；② 改为 1、1、0。两种情况下，哪一路输出为 0？','先逐项检查使能端的实际电平。满足使能条件后，再根据地址确定输出编号。','<ol class="steps"><li>实际电平为 1、0、0，满足使能条件。地址 010 对应 2 号输出，因此该路为 0，其余为 1。</li><li>改为 1、1、0 后，低有效使能端<span class="overline">S₂</span>的实际电平为 1，不满足使能条件。因此全部输出为 1，没有任何一路被选中。</li></ol>','依据课件 05 第 38 页功能表编制的自测。'))}
      ${note('decoder')}`,
      sources: ['c05-p38.png','hw05-p04.png']
    }
  };
  window.SOURCE_CAPTIONS = {
    'c05-p04.png':'课件 05 · 第 4 页 · 2:1 MUX', 'c05-p11.png':'课件 05 · 第 11 页 · 4:1 MUX',
    'c05-p17.png':'课件 05 · 第 17 页 · 8:1 MUX 实现函数', 'c05-p18.png':'课件 05 · 第 18 页 · 压缩为 4:1 MUX',
    'c05-p13.png':'课件 05 · 第 13 页 · 两级 MUX 扩展（使用电路部分）', 'c05-p20.png':'课件 05 · 第 20 页 · MUX 实现函数练习',
    'c05-p38.png':'课件 05 · 第 38 页 · 74LS138 功能表', 'hw05-p03.png':'组合模块 1 作业 · 第 3 页 · 第 3 题(b)',
    'hw05-p04.png':'组合模块 1 作业 · 第 4 页 · 地址译码', 'c03-p07.png':'课件 03 · 第 7 页 · 跨边相邻与圈组',
    'c03-p14.png':'课件 03 · 第 14 页 · 覆盖流程', 'c03-p19.png':'课件 03 · 第 19 页 · 多图相邻',
    'c03-p23.png':'课件 03 · 第 23 页 · 无关项', 'c03-p29.png':'课件 03 · 第 29 页 · 最大项法',
    'c04-p19.png':'课件 04 · 第 19 页 · 逻辑设计流程', 'ex07-p09.png':'组合逻辑习题课 · 第 9 页 ·【5】①'
  };
})();
