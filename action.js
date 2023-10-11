const core = require('@actions/core');
const github = require('@actions/github');
const asana = require('asana');

async function moveSection(client, taskId, targets) {
  const task = await client.tasks.findById(taskId);
  console.log('task', task)
  console.log('github payload: ', github.context.payload)
  console.log('github repo: ', github.context.repo)

  targets.forEach(async target => {
    const targetProject = task.projects.find(project => project.name === target.project);
    console.log('targetProject :', targetProject)

    if (!targetProject) {
      core.setFailed(`Asana project ${target.project} not found.`)
    }
    if (!targetProject) {
      core.info(`This task does not exist in "${target.project}" project`);
      return;
    }
    let targetSection = await client.sections.findByProject(targetProject.gid)
      .then(sections => sections.find(section => section.name === target.section));
    console.log('targetSection :', targetSection)
    if (targetSection) {
      await client.sections.addTask(targetSection.gid, { task: taskId });
      core.info(`Moved to: ${target.project}/${target.section}`);
    } else {
      core.setFailed(`Asana section ${target.section} not found.`)
      core.error(`Asana section ${target.section} not found.`);
    }
  });
}


async function updateStatus(client, taskId, targets) {
  const task = await client.tasks.findById(taskId);
  console.log('task', task)

  const statusOptions = task.custom_fields.find(f => f.name === 'Status').enum_options
  const targetStatus = statusOptions.find(status => status.name === targets[0].status)

  if(!targetStatus){
    return core.setFailed(`Status ${targets[0].status} does not exist.`)
  }

  const statusField = task.custom_fields.find(f => f.name === "Status")
 
  const newFields = {
    [statusField.gid]: targetStatus.gid
  }

  client.tasks.update(task.gid, { custom_fields: newFields });
}

async function findComment(client, taskId, commentId) {
  let stories;
  try {
    const storiesCollection = await client.tasks.stories(taskId);
    stories = await storiesCollection.fetch(200);
  } catch (error) {
    throw error;
  }

  return stories.find(story => story.text.indexOf(commentId) !== -1);
}

async function addComment(client, taskId, commentId, text, isPinned) {
  if (commentId) {
    text += '\n' + commentId + '\n';
  }
  try {
    const comment = await client.tasks.addComment(taskId, {
      text: text,
      is_pinned: isPinned,
    });
    return comment;
  } catch (error) {
    console.error('rejecting promise', error);
  }
}

async function buildClient(asanaPAT) {
  const asanaClient = asana.Client.create({
    defaultHeaders: { 'asana-enable': 'new-sections,string_ids' },
    logAsanaChangeWarnings: true
  }).useAccessToken(asanaPAT).authorize();
  return asanaClient;
}

async function action() {
  const
    ASANA_PAT = core.getInput('asana-pat', { required: true }),
    ACTION = core.getInput('action', { required: true }),
    TRIGGER_PHRASE = core.getInput('trigger-phrase') || '',
    PULL_REQUEST = github.context.payload.pull_request,
    REGEX_STRING = `${TRIGGER_PHRASE}(?:\s*)https:\\/\\/app.asana.com\\/(\\d+)\\/(?<project>\\d+)\\/(?<task>\\d+)`,
    REGEX = new RegExp(REGEX_STRING, 'g')
    ;

  console.log('pull_request', PULL_REQUEST);

  const client = await buildClient(ASANA_PAT);
  console.log('client : ', client)

  if (client === null) {
    throw new Error('client authorization failed');
  }

  console.info('looking in body', PULL_REQUEST.body, 'regex', REGEX_STRING);
  let foundAsanaTasks = [];
  while ((parseAsanaURL = REGEX.exec(PULL_REQUEST.body)) !== null) {
    const taskId = parseAsanaURL.groups.task;
    if (!taskId) {
      core.error(`Invalid Asana task URL after the trigger phrase ${TRIGGER_PHRASE}`);
      continue;
    }
    foundAsanaTasks.push(taskId);
  }

  if(!foundAsanaTasks.length){
    return core.setFailed(`This pull request is not linked to any asana task.`)
  }
  console.info(`found ${foundAsanaTasks.length} taskIds:`, foundAsanaTasks.join(','));

  console.info('calling', ACTION);
  //Creash app if foundAsanaTasks is 0
  switch (ACTION) {
    case 'assert-link': {
      const githubToken = core.getInput('github-token', { required: true });
      const linkRequired = core.getInput('link-required', { required: true }) === 'true';
      const octokit = new github.GitHub(githubToken);
      const statusState = (!linkRequired || foundAsanaTasks.length > 0) ? 'success' : 'error';
      core.info(`setting ${statusState} for ${github.context.payload.pull_request.head.sha}`);
      octokit.repos.createStatus({
        ...github.context.repo,
        'context': 'asana-link-presence',
        'state': statusState,
        'description': 'asana link not found',
        'sha': github.context.payload.pull_request.head.sha,
      });
      break;
    }
    case 'add-comment': {
      const commentId = core.getInput('comment-id'),
        htmlText = core.getInput('text', { required: true }),
        isPinned = core.getInput('is-pinned') === 'true';
      const comments = [];
      for (const taskId of foundAsanaTasks) {
        if (commentId) {
          const comment = await findComment(client, taskId, commentId);
          if (comment) {
            console.info('found existing comment', comment.gid);
            continue;
          }
        }
        const comment = await addComment(client, taskId, commentId, htmlText, isPinned);
        comments.push(comment);
      };
      return comments;
    }
    case 'remove-comment': {
      const commentId = core.getInput('comment-id', { required: true });
      const removedCommentIds = [];
      for (const taskId of foundAsanaTasks) {
        const comment = await findComment(client, taskId, commentId);
        if (comment) {
          console.info("removing comment", comment.gid);
          try {
            await client.stories.delete(comment.gid);
          } catch (error) {
            console.error('rejecting promise', error);
          }
          removedCommentIds.push(comment.gid);
        }
      }
      return removedCommentIds;
    }
    case 'complete-task': {
      const isComplete = core.getInput('is-complete') === 'true';
      const taskIds = [];
      for (const taskId of foundAsanaTasks) {
        console.info("marking task", taskId, isComplete ? 'complete' : 'incomplete');
        try {
          await client.tasks.update(taskId, {
            completed: isComplete
          });
        } catch (error) {
          console.error('rejecting promise', error);
        }
        taskIds.push(taskId);
      };
      return taskIds;
    }
    case 'move-section': {
      const targetJSON = core.getInput('targets', { required: true });
      const targets = JSON.parse(targetJSON);

      const movedTasks = [];
      for (const taskId of foundAsanaTasks) {
        await moveSection(client, taskId, targets);
        movedTasks.push(taskId);
      }
      return movedTasks;
    }
    case 'update-status': {
      const targetJSON = core.getInput('targets', { required: true });
      const targets = JSON.parse(targetJSON);

      const updatedTasks = [];
      for (const taskId of foundAsanaTasks) {
        await updateStatus(client, taskId, targets);
        updatedTasks.push(taskId);
      }
      return updatedTasks;
    }
    default:
      core.setFailed("unexpected action ${ACTION}");
  }
}

module.exports = {
  action,
  default: action,
  buildClient: buildClient
};