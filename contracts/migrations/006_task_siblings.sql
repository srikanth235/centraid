-- An explicit drag reads only its list/section/parent, including Inbox NULLs.
-- The existing partial project/parent indexes cannot cover the Inbox.
CREATE INDEX task_siblings ON task(project_id, section_id, parent_id, position, id);
