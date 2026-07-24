# Project workset resources

## Decision

Use the existing first-class `Project` as the workset container. Do not add a
parallel `Workset` entity or a second session-membership relationship.

Session membership remains canonical on
`omnigent_conversation_metadata.project_id` and continues to use the existing
session/project APIs described in `PROJECTS_PRD.md`.

## Resource associations

A project can also group lightweight references with one of four closed kinds:

- `repository`
- `task`
- `decision`
- `open_question`

Each `ProjectResource` stores a display `title` and an optional opaque
`reference`. The reference can be a repository URL/path, an internal object ID,
or an external system URL. The association does not own or duplicate the source
object's lifecycle.

This deliberately avoids inventing task, decision, or question workflows before
their source domains exist. A future source-specific model can keep the
`ProjectResource.reference` stable or replace the association behind the same
project API.

## Persistence and access

`project_resources` is workspace-partitioned and relates to `projects` through
`project_id`. Per schema Rule R032 there is no database foreign key; the project
store validates the owned project on every operation and removes associations
when deleting a project.

Resources inherit the project's current owner-private scope. An inaccessible
project returns not-found for resource reads and writes.

## API

- `POST /v1/projects/{project_id}/resources`
- `GET /v1/projects/{project_id}/resources`
- `GET /v1/projects/{project_id}/resources?kind=decision`
- `DELETE /v1/projects/{project_id}/resources/{resource_id}`

The create body is:

```json
{
  "kind": "repository",
  "title": "omnigent",
  "reference": "https://github.com/example/omnigent"
}
```

`reference` is optional. `title` is trimmed and bounded to 200 characters;
`reference` is trimmed and bounded to 2048 characters.
