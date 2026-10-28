import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec';
import type { JsonValue } from './protocol/serde_json/JsonValue';
const str={type:'string'};
const obj=(properties:Record<string,JsonValue>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const bits=obj(Object.fromEntries(['S1','S0','I0','I1','I2','I3'].map(k=>[k,{type:'integer',enum:[0,1]}])),['S1','S0','I0','I1','I2','I3']);
const example=obj({problem:str,steps:str,hint:str,answer:str,inputs:bits,output:{type:'integer',enum:[0,1]}},['problem','answer','inputs','output']);
const evidence=obj(Object.fromEntries(['enable','selection','formula','example','exercise'].map(k=>[k,{type:'array',items:str,maxItems:100}])),
  ['enable','selection','formula','example','exercise']);
export const GENERATION_TOOLS:DynamicToolSpec[]=[
  {type:'function',name:'yizhi_read_generation_context',description:'Read the fixed new unit/theme/source and actual confirmed parsed PDF artifact. Returns positioned L/H/X table cells, page text IDs, immutable digests, original raster provenance, current formal target/student baseline, committed stages and recoverable candidates. MUST call before proposing each stage and after a stale result.',inputSchema:obj({})},
  {type:'function',name:'yizhi_publish_lesson',description:'Submit a complete bounded four-channel selector lesson or an independent extra practice stage. Core validates actual source rows, claim-specific text IDs, full 64-row formula, examples, latest versions/drafts, task qualification and graph ownership. A retained result is a draft, NEVER a publication. Do lesson first and practice second; on explicit continuation skip stages with committed receipts. New proposal after failure needs a fresh operationId and fresh basisId.',inputSchema:obj({
    operationId:str,basisId:str,stage:{type:'string',enum:['lesson','practice']},title:str,outcome:str,intro:str,derivation:str,formula:str,
    example,exercise:example,evidence,
  },['operationId','basisId','stage','evidence'])},
  {type:'function',name:'yizhi_query_lesson',description:'Query the durable publication or retained-candidate receipt for the original model operationId after an uncertain tool response. Never duplicate an unknown publication.',inputSchema:obj({operationId:str},['operationId'])},
];
export const GENERATION_INSTRUCTIONS=`你是绎知新增来源的小主题生产助手。本任务只生成 submittedRequest.generationSpec 指定的新单元；原 target 是画板锚点，不可改其语义或重用 KU001。只能用给出的 yizhi_ 工具，不使用文件、shell、网络、SQL、MCP 或其他执行器。必须先调用 yizhi_read_generation_context，检查实际解析产物、版本、页面原图来源和表格坐标。来源页是未标记的表格，G 上横线不会出现在文本层，不能声称获得 Table 标签或 OCR；该页 G 高电平输出低，G 低电平按 B/A 选中 C0..C3。仅讲 Gbar=0 的一个通道：B→S1、A→S0、C0..C3→I0..I3、Y→Z。不得推断第二通道、时序、电气或真实芯片行为。
先提交 lesson：title/outcome/intro 至少完整解释符号、低有效使能和条件；intro 必须显式写出 B=S1、A=S0、Y=Z、C0=I0、C1=I1、C2=I2、C3=I3，读者不能只靠列表顺序猜映射。derivation 写明 00→C0、01→C1、10→C2、11→C3，并推导完整 Z 布尔式。example 给有步骤和答案的具体六输入题；exercise 给题目、提示、完整答案。answer 字段必须含 Z 值和至少一句依据，例如“Z=1，因为 10 选择 C2=I2，而给定 I2=1”，不可只有“Z=1”；steps 与 hint 不能代替 answer。两例都须在 inputs 中给 S1,S0,I0..I3 全六个0/1及 output。formula 使用 Z=、¬、·、+ 与括号的受支持语法。evidence 用读取返回的 evidenceIds 五类原样包含实际文本项，可添加精确项，不得编造 ID。完成 lesson 的真实 committed 回执后，读取新依据再提交 practice，给另一个具体练习（problem/hint/answer/inputs/output），exercise evidence 指向该题的实际选通行；其余四类 evidence 可为空数组，不重复 lesson 已校验的论断。这样第一组已是完整可读小主题，第二组是独立追加材料。只在收到 committed 回执时才说正式发布。候选 retained 时逐项读取 checks 的失败 detail，重新读取并用新 operationId 修正，原失败候选保留。继续任务时先核对 completedStages，只做 pendingStages，绝不重发已提交阶段。模型 turn 结束不等于两阶段发布完成。只报告真实回执。`;
