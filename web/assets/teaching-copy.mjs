// Display terminology only. Never mutate database fields, URLs or form values.
const terms = [
  ['试看片段', '教学影像试看内容'], ['短片段', '教学影像节选'],
  ['看过的片', '观看记录'], ['复盘长片', '长篇教学影像复盘'],
  ['片库', '教学影像库'], ['片名', '教学影像名称'], ['片长', '教学影像时长'],
  ['影片', '教学影像'], ['片子', '教学影像'], ['全片', '完整教学影像'],
  ['看片', '观看教学影像'], ['挑片', '选择教学影像'], ['新片', '新教学影像'],
  ['片段', '节选'], ['分片', '数据块'], ['图片', '图像'], ['照片', '实拍图'], ['卡片', '内容卡'],
];
export function teachingCopy(value) {
  let text = String(value ?? '');
  for (const [from, to] of terms) text = text.replaceAll(from, to);
  return text;
}
