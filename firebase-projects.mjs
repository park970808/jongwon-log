const PROJECTS = {
  jangwon: {
    apiKey: "AIzaSyAe-KaHt0a6yrV7-BXSOqycusA0Kv2Gz0A",
    authDomain: "jangwon-287b2.firebaseapp.com",
    projectId: "jangwon-287b2",
    storageBucket: "jangwon-287b2.firebasestorage.app",
    messagingSenderId: "85352966138",
    appId: "1:85352966138:web:37c613ead65a6fe881e643"
  },
  "team-2": {
    apiKey: "AIzaSyApQ1LKMnxhI1g7xMwPqwVUxUEfTHEDV-0",
    authDomain: "jongwon-log-team-2.firebaseapp.com",
    projectId: "jongwon-log-team-2",
    storageBucket: "jongwon-log-team-2.firebasestorage.app",
    messagingSenderId: "863440395387",
    appId: "1:863440395387:web:a4e117002b1ac81e3cd6de"
  }
};

export function firebaseConfigFor(teamId) {
  return Object.hasOwn(PROJECTS,teamId) ? PROJECTS[teamId] : null;
}
