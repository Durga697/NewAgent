import dotenv from 'dotenv';

export function loadEnvironment({env=process.env,localPath='.env.local',basePath='.env'}={}) {
  // A local developer's saved settings must replace stale inherited values.
  // Production and test processes own their environment and never read local secrets.
  if(!['production','test'].includes(env.NODE_ENV))dotenv.config({path:localPath,processEnv:env,override:true});
  dotenv.config({path:basePath,processEnv:env});
}
