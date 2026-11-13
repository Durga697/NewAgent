export const revealInFolder={
  name:'reveal_in_folder',description:'Show a previous search result selected in Windows Explorer, using only resultId. Wait for the user to choose when multiple results are plausible.',
  parameters:{type:'object',properties:{resultId:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['resultId'],additionalProperties:false},
  run(context,args){return context.files.act(context,'reveal',args.resultId);}
};
