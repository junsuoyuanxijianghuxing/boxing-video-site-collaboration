import { escapeCardText as e } from './lesson-card.mjs';
import { seriesDetailMarkup } from './series-markup.mjs';

let pendingDraft = null;
const copy = value => JSON.parse(JSON.stringify(value));
const cleanTags = value => [...new Set(String(value).split(/[,，\n]/).map(tag=>tag.trim()).filter(Boolean))];
const normalized = items => items.map(item=>({...item,title:item.title.trim(),description:item.description.trim(),
  characterTags:item.characterTags.map(tag=>tag.trim()),workTags:item.workTags.map(tag=>tag.trim())}));
const serialized = items => JSON.stringify(normalized(items));

export async function mountSeriesEditor(host,{get,post,posterSrc,hydratePosters,isWriteOutcomeUnknown,onSaved,onClose}) {
  const initial = await get('admin-lesson-series');
  if (!host.isConnected) return;
  let baseline=copy(initial.series), series=copy(initial.series), revision=initial.revision;
  let videos=initial.videos, selected=series[0]?.id??null, device='desktop', busy=false, uncertain=false, blocked=false;
  let status='改动只保存在当前草稿，点击保存后才会影响公开合集。', statusKind='idle', filter='', dragged=null;
  let undo=[],redo=[],writing=false;
  let cleanup=()=>{};
  const dirty=()=>serialized(series)!==serialized(baseline);
  const frozen=()=>busy||uncertain||blocked;
  if (pendingDraft) {
    series=copy(pendingDraft.series); selected=pendingDraft.selected??series[0]?.id??null;
    baseline=copy(pendingDraft.baseline);
    uncertain=pendingDraft.uncertain;
    if(pendingDraft.revision!==revision) { blocked=true; status='线上合集或教学影像已变化。保留的草稿供你核对；重新读取并放弃草稿后才能编辑。';statusKind='error'; }
    else { baseline=copy(pendingDraft.baseline);status=uncertain?'上次保存结果尚不明确，请先核对保存结果。':'已恢复当前浏览器里尚未保存的合集草稿。'; }
    revision=pendingDraft.revision;
  }
  const remember=()=>{pendingDraft=dirty()||uncertain||writing?{series:copy(series),baseline:copy(baseline),revision,selected,uncertain:uncertain||writing}:null;};
  const current=()=>series.find(item=>item.id===selected);
  function changed(action) {
    if(frozen())return;
    undo.push(copy(series));if(undo.length>30)undo.shift();redo=[];action();
    status='有尚未保存的修改。预览会同步更新，公开站点保持已保存版本。';statusKind='dirty';remember();
  }
  host.innerHTML=`<section class="series-editor panel stack" aria-labelledby="series-editor-title">
    <div class="spread"><div><p class="lesson-kicker">SERIES EDITOR</p><h2 id="series-editor-title">合集管理</h2><p class="dim">合集内部集序与首页展示顺序分别管理。移除分集不会删除原教学影像。</p></div><button class="btn" type="button" data-series-action="close">返回教学影像管理</button></div>
    <div class="series-actions row"><button class="btn" data-series-action="create" data-mutates>新建合集</button><button class="btn" data-series-action="undo" data-mutates>撤销</button><button class="btn" data-series-action="redo" data-mutates>重做</button><button class="btn btn-primary" data-series-action="save" data-mutates>保存全部合集</button><button class="btn" data-series-action="reconcile" hidden>核对保存结果</button><button class="btn btn-ghost" data-series-action="reload">重新读取并放弃草稿</button></div>
    <p class="series-draft-status" role="status" aria-live="polite"></p>
    <div class="series-editor-layout"><div class="series-editor-form stack"><div class="admin-series-list" aria-label="选择要编辑的合集"></div><div data-series-form></div></div>
      <div class="stack"><div class="spread"><div><h3>保存前预览</h3><p class="tiny dim">未登录访客视角；草稿合集发布后将按这个布局显示。</p></div><div class="row" role="group" aria-label="合集预览设备"><button class="btn btn-sm" data-series-device="desktop">桌面</button><button class="btn btn-sm" data-series-device="mobile">手机</button></div></div><div class="series-preview" data-device="desktop"><div data-series-preview></div></div></div></div>
  </section>`;
  function paintControls() {
    const line=host.querySelector('.series-draft-status');line.textContent=status;line.dataset.state=statusKind;
    for(const node of host.querySelectorAll('[data-mutates]')) node.disabled=frozen()||node.dataset.boundary==='1';
    host.querySelector('[data-series-action="undo"]').disabled=frozen()||!undo.length;
    host.querySelector('[data-series-action="redo"]').disabled=frozen()||!redo.length;
    host.querySelector('[data-series-action="save"]').disabled=frozen()||!dirty();
    host.querySelector('[data-series-action="save"]').textContent=busy?'正在保存…':'保存全部合集';
    host.querySelector('[data-series-action="reconcile"]').hidden=!uncertain;
    host.querySelector('[data-series-action="reconcile"]').disabled=busy;
    host.querySelector('[data-series-action="reload"]').disabled=busy||uncertain;
    host.querySelector('[data-series-action="close"]').disabled=busy;
    for(const button of host.querySelectorAll('[data-series-device]'))button.setAttribute('aria-pressed',String(button.dataset.seriesDevice===device));
  }
  function paintList() {
    host.querySelector('.admin-series-list').innerHTML=series.length?series.map(item=>`<button type="button" class="btn${item.id===selected?' btn-primary':''}" data-series-select="${e(item.id)}" aria-pressed="${item.id===selected}">${e(item.title||'尚未命名的合集')} · ${item.published?'公开':'草稿'}</button>`).join(''):'<p class="dim">还没有合集。新建后选择分集并预览。</p>';
  }
  function paintPreview() {
    const item=current(), slot=host.querySelector('[data-series-preview]');
    if(!item){slot.innerHTML='<p class="dim">选择或新建一个合集后，在这里查看编排效果。</p>';paintControls();return;}
    const map=new Map(videos.map(video=>[video.id,video]));
    const items=item.videoIds.filter(id=>map.has(id)).map((id,index)=>{
      const video=map.get(id);return {...video,episodeNumber:index+1,access:Number(video.tierRank)===0?'full':Number(video.previewSeconds)>0?'preview':'locked',rank:0};
    });
    slot.innerHTML=seriesDetailMarkup({...item,title:item.title||'尚未命名的合集',items,episodeCount:items.length,
      totalDurationSeconds:items.reduce((sum,video)=>sum+(Number(video.durationSeconds)||0),0),durationIncomplete:items.some(video=>!(Number(video.durationSeconds)>0)),cover:items.find(video=>video.hasPoster)??null},
    {posterUrlFor:video=>posterSrc(video.id,video.posterVersion),interactive:false});
    hydratePosters();paintControls();
  }
  function paintPicker() {
    const slot=host.querySelector('[data-series-picks]');if(!slot)return;
    const used=new Set(series.flatMap(item=>item.videoIds));
    const available=videos.filter(video=>!used.has(video.id)&&`${video.title} ${video.description}`.toLowerCase().includes(filter.toLowerCase()));
    slot.innerHTML=available.length?available.map(video=>`<div class="series-episode-row"><span>${e(video.title)}</span><button type="button" class="btn btn-sm" data-series-add="${e(video.id)}" data-mutates>加入合集</button></div>`).join(''):'<p class="tiny dim">没有匹配的可用教学影像；已归入其他合集的内容不在这里重复列出。</p>';
    paintControls();
  }
  function paintEpisodes() {
    const item=current(), slot=host.querySelector('[data-series-episodes]');if(!slot||!item)return;
    const map=new Map(videos.map(video=>[video.id,video]));
    slot.innerHTML=item.videoIds.length?item.videoIds.map((id,index)=>`<div class="series-episode-row" draggable="${!frozen()}" data-series-row="${e(id)}">
      <span class="mono">${index+1}</span><span>${e(map.get(id)?.title??'此教学影像已不可用，请移除引用')} ${map.has(id)?'':'<strong class="pill pill-warn">已下架或删除</strong>'}</span>
      <div class="row"><button class="btn btn-sm" type="button" data-series-move="${e(id)}" data-direction="-1" data-mutates data-boundary="${index===0?1:0}" aria-label="上移第 ${index+1} 集">上移</button><button class="btn btn-sm" type="button" data-series-move="${e(id)}" data-direction="1" data-mutates data-boundary="${index===item.videoIds.length-1?1:0}" aria-label="下移第 ${index+1} 集">下移</button><label class="tiny">位置 <input class="input" data-series-position="${e(id)}" data-mutates type="number" min="1" max="${item.videoIds.length}" value="${index+1}" aria-label="第 ${index+1} 集的位置"></label><button class="btn btn-sm btn-ghost" type="button" data-series-remove="${e(id)}" data-mutates>移出合集</button></div></div>`).join(''):'<p class="dim">从下面的已发布目录中加入分集。最多 100 集。</p>';
    paintControls();
  }
  function paintForm() {
    const slot=host.querySelector('[data-series-form]'), item=current();
    if(!item){slot.innerHTML='';return;}
    slot.innerHTML=`<div class="stack"><div class="field"><label for="series-title">合集名称</label><input class="input" id="series-title" maxlength="120" data-series-field="title" data-mutates value="${e(item.title)}"></div>
      <div class="field"><label for="series-description">合集简介</label><textarea class="input" id="series-description" maxlength="1000" rows="3" data-series-field="description" data-mutates>${e(item.description)}</textarea></div>
      <div class="field"><label for="series-characterTags">角色标签（逗号分隔，最多 8 个）</label><input class="input" id="series-characterTags" data-series-field="characterTags" data-mutates value="${e(item.characterTags.join('，'))}"></div>
      <div class="field"><label for="series-workTags">作品标签（逗号分隔，最多 8 个）</label><input class="input" id="series-workTags" data-series-field="workTags" data-mutates value="${e(item.workTags.join('，'))}"></div>
      <label class="row"><input type="checkbox" data-series-field="published" data-mutates ${item.published?'checked':''}> 保存后公开展示这个合集</label><p class="tiny dim">未勾选则保存为草稿，仅管理员可见；分集原有的公开状态和会员要求保持原设置。</p>
      <div class="series-episode-list" data-series-episodes aria-label="合集内分集顺序"></div>
      <h3>添加已发布教学影像</h3><label for="series-pick-search" class="tiny dim">按名称或说明筛选</label><input class="input" id="series-pick-search" type="search" value="${e(filter)}"><div class="series-pick-list" data-series-picks></div>
      <button class="btn btn-ghost" type="button" data-series-action="delete" data-mutates>删除当前合集关联（保存后生效）</button></div>`;
    paintEpisodes();paintPicker();
  }
  function paint(){paintList();paintForm();paintPreview();}
  function move(id,to) {
    if(!Number.isInteger(to))return;
    const item=current();if(!item)return;const from=item.videoIds.indexOf(id);
    to=Math.min(item.videoIds.length-1,Math.max(0,to));if(from<0||from===to)return;
    changed(()=>{item.videoIds.splice(from,1);item.videoIds.splice(to,0,id);});paintEpisodes();paintPreview();
    const row=host.querySelector(`[data-series-row="${id}"]`);row?.querySelector('[data-series-position]')?.focus();row?.scrollIntoView({block:'nearest'});
  }
  function adopt(data) {
    baseline=copy(data.series);series=copy(data.series);revision=data.revision;videos=data.videos;
    if(!series.some(item=>item.id===selected))selected=series[0]?.id??null;
    uncertain=false;blocked=false;undo=[];redo=[];pendingDraft=null;
  }
  async function save() {
    if(frozen()||!dirty())return;
    busy=true;writing=true;status='正在保存全部合集…';statusKind='saving';paintControls();
    try {const data=await post('admin-lesson-series-save',{series:normalized(series),revision});adopt(data);status='已保存。已勾选公开的有效合集现在可在前台查看。';statusKind='saved';onSaved?.();}
    catch(error){status=error.message||'合集保存未完成。';statusKind='error';if(error.code==='lesson_series_conflict')blocked=true;else if(isWriteOutcomeUnknown(error)){uncertain=true;status+=' 保存结果尚不明确，请先核对保存结果。';}remember();}
    finally{busy=false;writing=false;remember();if(host.isConnected)paint();}
  }
  async function reconcile() {
    if(busy)return;busy=true;paintControls();
    try{const data=await get('admin-lesson-series');
      if(serialized(data.series)===serialized(series)){adopt(data);status='核对完成：这份草稿已保存到服务器。';statusKind='saved';onSaved?.();}
      else if(serialized(data.series)===serialized(baseline)&&data.revision===revision){uncertain=false;status='核对完成：服务器仍是原版本。草稿已保留，可以再次保存。';statusKind='dirty';}
      else{uncertain=false;blocked=true;status='服务器已有其他更新。草稿仍保留在预览中，请核对后重新读取。';statusKind='error';}
      remember();
    }catch(error){status=error.message;statusKind='error';}finally{busy=false;if(host.isConnected)paint();}
  }
  const click=async event=>{
    const button=event.target.closest('button');if(!button||!host.contains(button))return;
    if(button.dataset.seriesSelect){selected=button.dataset.seriesSelect;paint();remember();return;}
    if(button.dataset.seriesDevice){device=button.dataset.seriesDevice;host.querySelector('.series-preview').dataset.device=device;paintControls();return;}
    const action=button.dataset.seriesAction;
    if(action==='close'){remember();cleanup();onClose?.();return;}
    if(action==='save'){await save();return;}
    if(action==='reconcile'){await reconcile();return;}
    if(action==='reload'&&!busy&&!uncertain){busy=true;paintControls();try{adopt(await get('admin-lesson-series'));status='已重新读取，之前的本地草稿已放弃。';statusKind='idle';}catch(error){status=error.message;statusKind='error';}finally{busy=false;if(host.isConnected)paint();}return;}
    if(frozen())return;
    if(action==='create'){if(series.length>=50){status='最多创建 50 个合集。';statusKind='error';paintControls();return;}changed(()=>{const item={id:crypto.randomUUID(),title:'',description:'',characterTags:[],workTags:[],published:false,videoIds:[]};series.push(item);selected=item.id;});paint();host.querySelector('#series-title')?.focus();return;}
    if(action==='undo'&&undo.length){redo.push(copy(series));series=undo.pop();selected=series.some(item=>item.id===selected)?selected:series[0]?.id;status='已撤销一步，尚未保存。';statusKind='dirty';remember();paint();return;}
    if(action==='redo'&&redo.length){undo.push(copy(series));series=redo.pop();selected=series.some(item=>item.id===selected)?selected:series[0]?.id;status='已重做一步，尚未保存。';statusKind='dirty';remember();paint();return;}
    const item=current();if(!item)return;
    if(action==='delete'){changed(()=>{series=series.filter(row=>row.id!==item.id);selected=series[0]?.id??null;});paint();return;}
    if(button.dataset.seriesAdd){if(item.videoIds.length>=100){status='单个合集最多 100 集。';statusKind='error';paintControls();return;}changed(()=>item.videoIds.push(button.dataset.seriesAdd));paintEpisodes();paintPicker();paintPreview();}
    if(button.dataset.seriesRemove){changed(()=>{item.videoIds=item.videoIds.filter(id=>id!==button.dataset.seriesRemove);});paintEpisodes();paintPicker();paintPreview();}
    if(button.dataset.seriesMove)move(button.dataset.seriesMove,item.videoIds.indexOf(button.dataset.seriesMove)+Number(button.dataset.direction));
  };
  const input=event=>{
    const node=event.target;
    if(node.id==='series-pick-search'){filter=node.value;paintPicker();return;}
    const field=node.dataset.seriesField,item=current();if(!field||!item||frozen())return;
    const value=field==='published'?node.checked:field.endsWith('Tags')?cleanTags(node.value):node.value;
    if(JSON.stringify(item[field])===JSON.stringify(value))return;
    changed(()=>{item[field]=value;});paintList();paintPreview();
  };
  const change=event=>{if(event.target.dataset.seriesPosition&&!frozen()){if(!event.target.value){paintEpisodes();return;}move(event.target.dataset.seriesPosition,Number(event.target.value)-1);}};
  const dragstart=event=>{if(frozen())return;dragged=event.target.closest('[data-series-row]')?.dataset.seriesRow??null;if(dragged)event.dataTransfer?.setData('text/plain',dragged);};
  const dragover=event=>{if(!frozen()&&dragged&&event.target.closest('[data-series-row]'))event.preventDefault();};
  const drop=event=>{const row=event.target.closest('[data-series-row]');if(!row||!dragged||frozen())return;event.preventDefault();move(dragged,current().videoIds.indexOf(row.dataset.seriesRow));dragged=null;};
  const beforeunload=event=>{if(dirty()||uncertain){event.preventDefault();event.returnValue='';}};
  const previewScroll=()=>hydratePosters();
  const previewBox=host.querySelector('.series-preview');
  previewBox.addEventListener('scroll',previewScroll,{passive:true});
  host.addEventListener('click',click);host.addEventListener('input',input);host.addEventListener('change',change);host.addEventListener('dragstart',dragstart);host.addEventListener('dragover',dragover);host.addEventListener('drop',drop);window.addEventListener('beforeunload',beforeunload);
  const observer=new MutationObserver(()=>{if(!host.isConnected){remember();cleanup();}});
  cleanup=()=>{host.removeEventListener('click',click);host.removeEventListener('input',input);host.removeEventListener('change',change);host.removeEventListener('dragstart',dragstart);host.removeEventListener('dragover',dragover);host.removeEventListener('drop',drop);previewBox.removeEventListener('scroll',previewScroll);window.removeEventListener('beforeunload',beforeunload);observer.disconnect();};
  observer.observe(document.getElementById('main')??document.body,{childList:true,subtree:true});
  paint();
}
