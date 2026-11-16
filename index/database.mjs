import sqlite from 'node-sqlite3-wasm';
import {ToolError} from '../tools/errors.mjs';
import {normalizeName,classify,rank,trigrams} from '../search/ranking.mjs';
const schema=`
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY,canonical_path TEXT NOT NULL,normalized_path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,normalized_name TEXT NOT NULL,extension TEXT NOT NULL,file_type TEXT NOT NULL,parent_path TEXT NOT NULL,root_id TEXT NOT NULL,drive_id TEXT NOT NULL,size_bytes INTEGER NOT NULL,created_at REAL,modified_at REAL NOT NULL,indexed_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,filesystem_identity TEXT NOT NULL,ino REAL,dev REAL,is_directory INTEGER NOT NULL,availability_status TEXT NOT NULL DEFAULT 'available',run_id TEXT);
CREATE TABLE IF NOT EXISTS index_runs(run_id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL,total_scanned INTEGER NOT NULL DEFAULT 0,total_indexed INTEGER NOT NULL DEFAULT 0,total_skipped INTEGER NOT NULL DEFAULT 0,total_errors INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS index_queue(target_path TEXT PRIMARY KEY,root_id TEXT NOT NULL,operation_type TEXT NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS files_drive ON files(drive_id,modified_at DESC,id);
CREATE INDEX IF NOT EXISTS files_parent ON files(parent_path);
CREATE INDEX IF NOT EXISTS files_ext ON files(extension,modified_at DESC,id);
CREATE INDEX IF NOT EXISTS files_type ON files(file_type,modified_at DESC,id);
CREATE INDEX IF NOT EXISTS files_modified ON files(modified_at DESC,id);
CREATE INDEX IF NOT EXISTS files_created ON files(created_at DESC,id);
CREATE INDEX IF NOT EXISTS files_size ON files(size_bytes DESC,id);
CREATE INDEX IF NOT EXISTS files_root ON files(root_id,run_id);
CREATE INDEX IF NOT EXISTS files_root_size ON files(root_id,is_directory,availability_status,size_bytes DESC,id);
CREATE INDEX IF NOT EXISTS files_root_modified ON files(root_id,is_directory,availability_status,modified_at DESC,id);
CREATE INDEX IF NOT EXISTS files_root_created ON files(root_id,is_directory,availability_status,created_at DESC,id);
CREATE INDEX IF NOT EXISTS files_root_name ON files(root_id,is_directory,availability_status,normalized_name,id);
CREATE INDEX IF NOT EXISTS files_name ON files(normalized_name,id);
CREATE VIRTUAL TABLE IF NOT EXISTS filename_fts USING fts5(normalized_name,content='files',content_rowid='id',tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS filename_trigrams USING fts5(normalized_name,content='files',content_rowid='id',tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN INSERT INTO filename_fts(rowid,normalized_name) VALUES(new.id,new.normalized_name);INSERT INTO filename_trigrams(rowid,normalized_name) VALUES(new.id,new.normalized_name);END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN INSERT INTO filename_fts(filename_fts,rowid,normalized_name) VALUES('delete',old.id,old.normalized_name);INSERT INTO filename_trigrams(filename_trigrams,rowid,normalized_name) VALUES('delete',old.id,old.normalized_name);END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE OF normalized_name ON files BEGIN INSERT INTO filename_fts(filename_fts,rowid,normalized_name) VALUES('delete',old.id,old.normalized_name);INSERT INTO filename_fts(rowid,normalized_name) VALUES(new.id,new.normalized_name);INSERT INTO filename_trigrams(filename_trigrams,rowid,normalized_name) VALUES('delete',old.id,old.normalized_name);INSERT INTO filename_trigrams(rowid,normalized_name) VALUES(new.id,new.normalized_name);END;
`;
export const pathKey=p=>process.platform==='win32'?p.toLowerCase():p;
export function mapRow(r){return {databaseId:r.id,path:r.canonical_path,name:r.name,folder:r.parent_path,rootId:r.root_id,driveId:r.drive_id,size:r.size_bytes,createdAt:r.created_at?new Date(r.created_at).toISOString():null,modifiedAt:new Date(r.modified_at).toISOString(),mtimeMs:r.modified_at,ino:r.ino,dev:r.dev,extension:r.extension,fileType:r.file_type,isDirectory:!!r.is_directory,availability:r.availability_status};}
export class IndexDatabase {
  constructor(filename,settings){
    this.settings=settings;
    try{this.db=new sqlite.Database(filename);const version=this.db.get('PRAGMA user_version').user_version;if(version>1)throw new ToolError('INDEX_SCHEMA_MISMATCH','The index was created by a newer Edith version.');
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-16000;');
      if(this.db.get('PRAGMA quick_check').quick_check!=='ok')throw new Error();
      this.db.exec('BEGIN IMMEDIATE');try{this.db.exec(schema);this.db.run('INSERT OR IGNORE INTO schema_migrations VALUES(1,?)',[Date.now()]);this.db.exec('PRAGMA user_version=1; COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
      this.db.run("UPDATE index_runs SET status='interrupted',finished_at=? WHERE status IN ('running','paused')",[Date.now()]);
    }catch(e){this.db?.close();if(e instanceof ToolError)throw e;throw new ToolError('INDEX_CORRUPT','The index could not be opened. Preserve it and use the authenticated rebuild control.');}
  }
  count(){return this.db.get('SELECT COUNT(*) n FROM files').n;}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  upsert(items,runId){
    const statement=this.db.prepare(`INSERT INTO files(canonical_path,normalized_path,name,normalized_name,extension,file_type,parent_path,root_id,drive_id,size_bytes,created_at,modified_at,indexed_at,last_seen_at,filesystem_identity,ino,dev,is_directory,availability_status,run_id) VALUES(${Array(20).fill('?').join(',')}) ON CONFLICT(normalized_path) DO UPDATE SET canonical_path=excluded.canonical_path,name=excluded.name,normalized_name=excluded.normalized_name,extension=excluded.extension,file_type=excluded.file_type,parent_path=excluded.parent_path,root_id=excluded.root_id,drive_id=excluded.drive_id,size_bytes=excluded.size_bytes,created_at=excluded.created_at,modified_at=excluded.modified_at,indexed_at=excluded.indexed_at,last_seen_at=excluded.last_seen_at,filesystem_identity=excluded.filesystem_identity,ino=excluded.ino,dev=excluded.dev,is_directory=excluded.is_directory,availability_status='available',run_id=excluded.run_id`);
    try{return this.transaction(()=>{for(const item of items)statement.run([item.path,pathKey(item.path),item.name,normalizeName(item.name),item.extension,item.fileType||classify(item.extension),item.folder,item.rootId,item.driveId,item.size,item.createdMs||null,item.mtimeMs,Date.now(),Date.now(),`${item.dev}:${item.ino}`,item.ino,item.dev,item.isDirectory?1:0,'available',runId]);});}finally{statement.finalize();}
  }
  unavailable(root){this.db.run("UPDATE files SET availability_status='unavailable' WHERE root_id=?",[root]);}
  reconcile(root,runId){this.db.run("DELETE FROM files WHERE root_id=? AND (run_id IS NULL OR run_id<>?)",[root,runId]);}
  remove(target){const key=pathKey(target);this.db.run('DELETE FROM files WHERE normalized_path=? OR substr(normalized_path,1,?)=?',[key,key.length+1,key+(process.platform==='win32'?'\\':'/')]);}
  search(query){
    const clauses=["availability_status='available'"],params=[];
    if(query.folderPath){const key=pathKey(query.folderPath);clauses.push('(normalized_path=? OR substr(normalized_path,1,?)=?)');params.push(key,key.length+1,key+(process.platform==='win32'?'\\':'/'));}
    if(query.rootIds?.length){clauses.push(`root_id IN (${query.rootIds.map(()=>'?').join(',')})`);params.push(...query.rootIds);}else return {matches:[],limited:false};
    for(const [field,column] of [['drive','drive_id'],['fileType','file_type']])if(query[field]){clauses.push(`${column}=?`);params.push(field==='drive'?query[field].toUpperCase().replace(/\\$/,''):query[field]);}
    if(query.extensions?.length){clauses.push(`extension IN (${query.extensions.map(()=>'?').join(',')})`);params.push(...query.extensions.map(x=>'.'+x.replace(/^\./,'').toLowerCase()));}
    for(const [field,column,op] of [['minSize','size_bytes','>='],['maxSize','size_bytes','<='],['createdAfterMs','created_at','>='],['createdBeforeMs','created_at','<='],['modifiedAfterMs','modified_at','>='],['modifiedBeforeMs','modified_at','<=']])if(query[field]!==undefined){clauses.push(`${column}${op}?`);params.push(query[field]);}
    clauses.push('is_directory=?');params.push(query.isDirectory?1:0);
    const order={modifiedDesc:'modified_at DESC',modifiedAsc:'modified_at ASC',createdDesc:'created_at DESC',createdAsc:'created_at ASC',sizeDesc:'size_bytes DESC',sizeAsc:'size_bytes ASC',name:'normalized_name ASC',nameDesc:'normalized_name DESC',relevance:'modified_at DESC'}[query.sortBy];if(!order)throw new ToolError('INVALID_FILTER','Unsupported sort order.');
    const where=clauses.join(' AND '),limit=this.settings.candidateLimit;
    let rows=[],candidateTruncated=false;
    if(query.tokens.length){
      const expression=query.tokens.map(t=>'"'+t.replaceAll('"','""')+'"*').join(' AND ');
      rows=this.db.all(`SELECT * FROM files NOT INDEXED WHERE id IN (SELECT rowid FROM filename_fts WHERE filename_fts MATCH ?) AND ${where} ORDER BY ${order},id LIMIT ?`,[expression,...params,limit]);
      // Bounded trigram candidate retrieval handles transpositions and partial tokens.
      const grams=[...new Set(query.tokens.flatMap(trigrams))].slice(0,64);
      if(grams.length&&rows.length===0){
        candidateTruncated=true;
        // Diversify by token anchors: a rare erroneous gram must not crowd out all
        // viable candidates (e.g. "resmee" also matches the unrelated "meeting").
        const anchors=[...new Set(query.tokens.flatMap(t=>{const g=trigrams(t);return [g[0],g.at(-1),g[Math.floor(g.length/2)]].filter(Boolean);} ))].slice(0,12),ids=new Set(rows.map(r=>r.id)),budget=Math.max(50,Math.floor(limit/Math.max(1,anchors.length)));
        for(const gram of anchors){const fuzzy=this.db.all(`SELECT * FROM files NOT INDEXED WHERE id IN (SELECT rowid FROM filename_trigrams WHERE filename_trigrams MATCH ? ORDER BY rank LIMIT ?) AND ${where} ORDER BY ${order},id LIMIT ?`,['"'+gram+'"',budget,...params,budget]);for(const row of fuzzy)if(!ids.has(row.id)){rows.push(row);ids.add(row.id);}}
      }
    }else rows=this.db.all(`SELECT * FROM files WHERE ${where} ORDER BY ${order},id LIMIT ?`,[...params,this.settings.snapshotLimit+1]);
    const ranked=[];for(const row of rows){const score=query.tokens.length?rank(row.name,query.tokens,this.settings.ranking):0;if(score!==null)ranked.push({...row,score});}
    const compare=(a,b)=>query.sortBy==='relevance'?b.score-a.score||b.modified_at-a.modified_at:query.sortBy==='name'?a.normalized_name.localeCompare(b.normalized_name):query.sortBy==='nameDesc'?b.normalized_name.localeCompare(a.normalized_name):query.sortBy==='sizeDesc'?b.size_bytes-a.size_bytes:query.sortBy==='sizeAsc'?a.size_bytes-b.size_bytes:query.sortBy==='createdDesc'?b.created_at-a.created_at:query.sortBy==='createdAsc'?a.created_at-b.created_at:query.sortBy==='modifiedAsc'?a.modified_at-b.modified_at:b.modified_at-a.modified_at;
    ranked.sort((a,b)=>compare(a,b)||a.normalized_path.localeCompare(b.normalized_path));return {matches:ranked.slice(0,this.settings.snapshotLimit).map(r=>({...mapRow(r),matchReason:query.tokens.length?'Filename token / fuzzy match':'Metadata filters'})),limited:candidateTruncated||ranked.length>this.settings.snapshotLimit||rows.length>=limit};
  }
  health(){return {version:this.db.get('SELECT sqlite_version() version').version,schemaVersion:1,journalMode:this.db.get('PRAGMA journal_mode').journal_mode,count:this.count(),lastRun:this.db.get('SELECT status,finished_at FROM index_runs ORDER BY started_at DESC LIMIT 1')||null};}
  rebuild(){this.transaction(()=>{this.db.exec('DELETE FROM files;DELETE FROM index_queue;DELETE FROM index_runs;');});}
  close(){this.db.close();}
}
