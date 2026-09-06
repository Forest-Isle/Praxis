/* global module */
function filterCompleted(tasks, completed) {
  if (completed === undefined) return tasks.filter((task) => task.completed)
  return tasks.filter((task) => task.completed === completed)
}
function addTask(tasks, task) {
  return tasks.concat(task)
}
function parseTasks(text) {
  return JSON.parse(text)
}
module.exports = { filterCompleted, addTask, parseTasks }
