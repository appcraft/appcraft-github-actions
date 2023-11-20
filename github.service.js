const github = require('@actions/github');

class GithubService {
  constructor(token) {
    // this.octokit = new Octokit({
    //   auth: token,
    // });
    this.octokit = new github.GitHub(token);
  }

  getDeployements = async () => {
    return await this.octokit.request('GET /repos/{owner}/{repo}/deployments', {
      owner: 'appcraft',
      repo: 'appcraft-everywhere-platform',
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  };

  getPullRequests = async () => {
    return await this.octokit.request('GET /repos/{owner}/{repo}/branches', {
      owner: 'appcraft',
      repo: 'appcraft-everywhere-platform',
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  };
}

module.exports = {
  GithubService,
};
