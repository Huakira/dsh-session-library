import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, libraryRows, paginateRows, groupedLibraryRows, abbreviatePath } from '../client/library-model.mjs';
const sessions = { ids: Array.from({length:3188},(_,i)=>String(i)), byId: {} };
for (const id of sessions.ids) sessions.byId[id] = {id,displayTitle:`历史会话 ${id}`,updatedAt:+id,cwd:'/work'};
const workspaces = {items:[{workspaceId:'project',id:'project',title:'研究',sessionIds:['1','2']}],archivedSessionIds:['0','1'],pinnedSessionIds:['2']};
test('large library uses fixed page bounds and reaches final historical row',()=>{
 const rows=libraryRows(sessions,workspaces);
 assert.equal(rows.length,3188);
 assert.equal(paginateRows(rows,0,50).items.length,50);
 const last=paginateRows(rows,1000,50);
 assert.equal(last.page,63);assert.equal(last.items.length,38);assert.equal(last.items.at(-1).id,'0');
 assert.equal(paginateRows(rows,-1,5000).items.length,50);
});
test('metadata searches complete catalog, archived and project scopes are independent',()=>{
 assert.equal(libraryRows(sessions,workspaces,{query:'历史会话 0'})[0].id,'0');
 assert.deepEqual(libraryRows(sessions,workspaces,{tab:'archived'}).map(x=>x.id),['1','0']);
 assert.equal(libraryRows(sessions,workspaces,{tab:'active'}).length,3186);
 assert.deepEqual(libraryRows(sessions,workspaces,{workspace:'project'}).map(x=>x.id),['2','1']);
});
test('rows carry real workspace ids and ungrouped sessions fall back to the bucket key',()=>{
 const rows=libraryRows(sessions,workspaces);
 assert.equal(rows.find(x=>x.id==='1').workspaceId,'project');
 assert.equal(rows.find(x=>x.id==='1').workspace,'研究');
 assert.equal(rows.find(x=>x.id==='5').workspaceId,'__ungrouped__');
 assert.equal(rows.find(x=>x.id==='5').workspace,'未分组');
});
test('content search uses host hits only, keeps snippets as inert text',()=>{
 const rows=libraryRows(sessions,workspaces,{query:'正文',content:true},[{sessionId:'1',snippet:'<script>unsafe()</script>'}]);
 assert.equal(rows.length,1);assert.equal(rows[0].snippet,'<script>unsafe()</script>');
 assert.equal(libraryRows(sessions,workspaces,{query:'正文',content:true}).length,0);
});
test('config normalizes unsupported values and caps DOM page sizes',()=>{
 assert.deepEqual(normalizeConfig({sidebarLimit:9999,pageSize:9999}),{sidebarLimit:100,pageSize:50,sidebarGrouping:'folders',groupLimit:5,libraryView:'list'});
 assert.deepEqual(normalizeConfig({sidebarLimit:-1,pageSize:25}),{sidebarLimit:5,pageSize:25,sidebarGrouping:'folders',groupLimit:5,libraryView:'list'});
 assert.deepEqual(normalizeConfig(null),{sidebarLimit:30,pageSize:50,sidebarGrouping:'folders',groupLimit:5,libraryView:'list'});
 assert.deepEqual(normalizeConfig({sidebarGrouping:'projects',groupLimit:10,libraryView:'folders'}),{sidebarLimit:30,pageSize:50,sidebarGrouping:'projects',groupLimit:10,libraryView:'folders'});
 assert.deepEqual(normalizeConfig({sidebarGrouping:'bad',groupLimit:7,libraryView:'tree'}),{sidebarLimit:30,pageSize:50,sidebarGrouping:'folders',groupLimit:5,libraryView:'list'});
});
test('folder view groups by folder first, then workspace, preserving order',()=>{
 const rows=[
  {id:'3',folderId:'f1',folderName:'重点',workspaceId:'w1',workspace:'研究'},
  {id:'1',folderId:'',workspaceId:'w1',workspace:'研究'},
  {id:'2',folderId:'',workspaceId:'__ungrouped__',workspace:'未分组'},
  {id:'4',folderId:'f1',folderName:'重点',workspaceId:'w1',workspace:'研究'},
 ];
 const groups=groupedLibraryRows(rows,[{id:'f1',name:'重点'}]);
 assert.deepEqual(groups.map(g=>g.key),['folder:f1','workspace:w1','workspace:__ungrouped__']);
 assert.deepEqual(groups[0].rows.map(r=>r.id),['3','4']);
 assert.equal(groups[0].name,'重点');
 assert.equal(groups[2].name,'未分组');
 assert.deepEqual(groupedLibraryRows([],[]),[]);
});
test('abbreviatePath shortens home prefix and very long paths',()=>{
 assert.equal(abbreviatePath('/Users/demo/proj','/Users/demo'),'~/proj');
 assert.equal(abbreviatePath('/opt/dsh','/Users/demo'),'/opt/dsh');
 assert.equal(abbreviatePath('','/Users/demo'),'');
 const long='/very/'.repeat(20)+'end';
 assert.ok(abbreviatePath(long,'').length<60);
 assert.ok(abbreviatePath(long,'').includes('…'));
});
