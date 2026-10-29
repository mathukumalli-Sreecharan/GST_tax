const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const corrupt=/[\u00c2\u00c3\ufffd\u0080-\u009f]|\u00e2[\u0080-\u00bf\u2000-\u2122]|\u00ef\u00bf\u00bd|[\u00b9\u00b2\u00b3\u2070-\u2079]/u;
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):[path.join(dir,entry.name)]);}
test('frontend copy uses valid UTF-8 without mojibake or accidental superscripts',()=>{
 const decoder=new TextDecoder('utf-8',{fatal:true});
 for(const file of [...files('app'),...files('components'),...files('lib'),'middleware.ts'].filter(name=>/\.(tsx?|css)$/.test(name))){
  assert.ok(!corrupt.test(decoder.decode(fs.readFileSync(file))),`Corrupted static text in ${file}`);
 }
});
test('static UI copy excludes framework terminology and removed settings internals',()=>{
 for(const file of [...files('app'),...files('components'),'middleware.ts'].filter(name=>/\.tsx?$/.test(name))){
  const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  function visit(node){
   if(ts.isStringLiteralLike(node)||ts.isJsxText(node))assert.ok(!/FastAPI|OpenPyXL|backend framework|workbook preservation/i.test(node.text),`Internal terminology in ${file}`);
   ts.forEachChild(node,visit);
  }
  visit(source);
 }
});
test('policy copy retains engine thresholds and all four workflow steps',()=>{
 const source=fs.readFileSync('components/Workspace.tsx','utf8');
 for(const text of ['Less than \u20b91','\u20b91 to less than \u20b950','\u20b950 or greater','0%, 5%, 12%, 18%, and 28%'])assert.ok(source.includes(text),text);
 assert.ok(source.includes('["Upload", "Column mapping", "Process", "Results"]'));
 assert.ok(!source.includes('upload-meta'));
});
