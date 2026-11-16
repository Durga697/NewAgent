export const listAllowedFolders={
  name:'list_allowed_folders',description:'List the local folders Edith is allowed to search, with availability and indexing warnings. Only metadata is read.',
  parameters:{type:'object',properties:{},additionalProperties:false},
  async run(context){return {enabled:context.files.config.enabled,folders:context.files.index.folders(),indexing:context.files.index.loading,indexCount:context.files.index.progress.count,limited:!!context.files.index.progress.truncated};}
};
