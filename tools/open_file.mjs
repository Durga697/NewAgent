export const openFile={
  name:'open_file',description:'Open a previous search result in its default Windows app using only resultId. Ask Open <filename>? unless the user explicitly asked to open it. With multiple matches wait for the user to select one; never guess. May return confirmation_required.',
  parameters:{type:'object',properties:{resultId:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['resultId'],additionalProperties:false},
  run(context,args){return context.files.act(context,'open',args.resultId);}
};
