export type GeneratedFile = {id:string;output_filename:string;original_filename:string;file_size:number;
 created_at:string;expires_at:string;verification_count:number;processing_summary:Record<string,unknown>};
export type FileList = {files:GeneratedFile[];total:number;retention_days:number};
export function formatFileSize(bytes:number):string {
 return bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;
}
