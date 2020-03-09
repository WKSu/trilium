const sql = require('./sql');
const log = require('./log');
const syncTableService = require('./sync_table');
const eventService = require('./events');

async function updateEntity(sync, entity, sourceId) {
    // can be undefined for options with isSynced=false
    if (!entity) {
        return;
    }

    const {entityName} = sync;

    if (entityName === 'notes') {
        await updateNote(entity, sourceId);
    }
    else if (entityName === 'note_contents') {
        await updateNoteContent(entity, sourceId);
    }
    else if (entityName === 'branches') {
        await updateBranch(entity, sourceId);
    }
    else if (entityName === 'note_revisions') {
        await updateNoteRevision(entity, sourceId);
    }
    else if (entityName === 'note_revision_contents') {
        await updateNoteRevisionContent(entity, sourceId);
    }
    else if (entityName === 'note_reordering') {
        await updateNoteReordering(sync.entityId, entity, sourceId);
    }
    else if (entityName === 'options') {
        await updateOptions(entity, sourceId);
    }
    else if (entityName === 'recent_notes') {
        await updateRecentNotes(entity, sourceId);
    }
    else if (entityName === 'attributes') {
        await updateAttribute(entity, sourceId);
    }
    else if (entityName === 'api_tokens') {
        await updateApiToken(entity, sourceId);
    }
    else {
        throw new Error(`Unrecognized entity type ${entityName}`);
    }

    // currently making exception for protected notes and note revisions because here
    // the title and content are not available decrypted as listeners would expect
    if (!['notes', 'note_contents', 'note_revisions', 'note_revision_contents'].includes(entityName) || !entity.isProtected) {
        await eventService.emit(eventService.ENTITY_SYNCED, {
            entityName,
            entity
        });
    }
}

function shouldWeUpdateEntity(localEntity, remoteEntity) {
    if (!localEntity) {
        return true;
    }

    const localDate = localEntity.utcDateModified || localEntity.utcDateCreated;
    const remoteDate = remoteEntity.utcDateModified || remoteEntity.utcDateCreated;

    if (localDate < remoteDate) {
        return true;
    }

    // this can happen in case of sync error when hashes are different but dates are the same - we should still update
    if (localEntity.hash !== remoteEntity.hash && localDate === remoteDate) {
        return true;
    }

    return false;
}

async function updateNote(remoteEntity, sourceId) {
    const localEntity = await sql.getRow("SELECT * FROM notes WHERE noteId = ?", [remoteEntity.noteId]);

    if (shouldWeUpdateEntity(localEntity, remoteEntity)) {
        await sql.transactional(async () => {
            await sql.replace("notes", remoteEntity);

            await syncTableService.addNoteSync(remoteEntity.noteId, sourceId);
        });

        log.info("Update/sync note " + remoteEntity.noteId);
    }
}

async function updateNoteContent(remoteEntity, sourceId) {
    const localEntity = await sql.getRow("SELECT * FROM note_contents WHERE noteId = ?", [remoteEntity.noteId]);

    if (shouldWeUpdateEntity(localEntity, remoteEntity)) {
        remoteEntity.content = remoteEntity.content === null ? null : Buffer.from(remoteEntity.content, 'base64');

        await sql.transactional(async () => {
            await sql.replace("note_contents", remoteEntity);

            await syncTableService.addNoteContentSync(remoteEntity.noteId, sourceId);
        });

        log.info("Update/sync note content for noteId=" + remoteEntity.noteId);
    }
}

async function updateBranch(remoteEntity, sourceId) {
    const localEntity = await sql.getRowOrNull("SELECT * FROM branches WHERE branchId = ?", [remoteEntity.branchId]);

    await sql.transactional(async () => {
        if (shouldWeUpdateEntity(localEntity, remoteEntity)) {
            // isExpanded is not synced unless it's a new branch instance
            // otherwise in case of full new sync we'll get all branches (even root) collapsed.
            if (localEntity) {
                delete remoteEntity.isExpanded;
            }

            await sql.replace('branches', remoteEntity);

            await syncTableService.addBranchSync(remoteEntity.branchId, sourceId);

            log.info("Update/sync branch " + remoteEntity.branchId);
        }
    });
}

async function updateNoteRevision(remoteEntity, sourceId) {
    const localEntity = await sql.getRowOrNull("SELECT * FROM note_revisions WHERE noteRevisionId = ?", [remoteEntity.noteRevisionId]);

    await sql.transactional(async () => {
        if (shouldWeUpdateEntity(localEntity, remoteEntity)) {
            await sql.replace('note_revisions', remoteEntity);

            await syncTableService.addNoteRevisionSync(remoteEntity.noteRevisionId, sourceId);

            log.info("Update/sync note revision " + remoteEntity.noteRevisionId);
        }
    });
}

async function updateNoteRevisionContent(remoteEntity, sourceId) {
    const localEntity = await sql.getRowOrNull("SELECT * FROM note_revision_contents WHERE noteRevisionId = ?", [remoteEntity.noteRevisionId]);

    await sql.transactional(async () => {
        if (shouldWeUpdateEntity(localEntity, remoteEntity)) {
            remoteEntity.content = remoteEntity.content === null ? null : Buffer.from(remoteEntity.content, 'base64');

            await sql.replace('note_revision_contents', remoteEntity);

            await syncTableService.addNoteRevisionContentSync(remoteEntity.noteRevisionId, sourceId);

            log.info("Update/sync note revision content " + remoteEntity.noteRevisionId);
        }
    });
}

async function updateNoteReordering(entityId, remote, sourceId) {
    await sql.transactional(async () => {
        for (const key in remote) {
            await sql.execute("UPDATE branches SET notePosition = ? WHERE branchId = ?", [remote[key], key]);
        }

        await syncTableService.addNoteReorderingSync(entityId, sourceId);
    });
}

async function updateOptions(remoteEntity, sourceId) {
    const localEntity = await sql.getRowOrNull("SELECT * FROM options WHERE name = ?", [remoteEntity.name]);

    if (localEntity && !localEntity.isSynced) {
        return;
    }

    await sql.transactional(async () => {
        if (shouldWeUpdateEntity(localEntity, remoteEntity)) {
            await sql.replace('options', remoteEntity);

            await syncTableService.addOptionsSync(remoteEntity.name, sourceId, true);
        }
    });
}

async function updateRecentNotes(remoteEntity, sourceId) {
    const localEntity = await sql.getRowOrNull("SELECT * FROM recent_notes WHERE noteId = ?", [remoteEntity.noteId]);

    if (shouldWeUpdateEntity(localEntity, remoteEntity)) {
        await sql.transactional(async () => {
            await sql.replace('recent_notes', remoteEntity);

            await syncTableService.addRecentNoteSync(remoteEntity.noteId, sourceId);
        });
    }
}

async function updateAttribute(remoteEntity, sourceId) {
    const localEntity = await sql.getRow("SELECT * FROM attributes WHERE attributeId = ?", [remoteEntity.attributeId]);

    if (shouldWeUpdateEntity(localEntity, remoteEntity)) {
        await sql.transactional(async () => {
            await sql.replace("attributes", remoteEntity);

            await syncTableService.addAttributeSync(remoteEntity.attributeId, sourceId);
        });

        log.info("Update/sync attribute " + remoteEntity.attributeId);
    }
}

async function updateApiToken(entity, sourceId) {
    const apiTokenId = await sql.getRow("SELECT * FROM api_tokens WHERE apiTokenId = ?", [entity.apiTokenId]);

    if (!apiTokenId) {
        await sql.transactional(async () => {
            await sql.replace("api_tokens", entity);

            await syncTableService.addApiTokenSync(entity.apiTokenId, sourceId);
        });

        log.info("Update/sync API token " + entity.apiTokenId);
    }
}

module.exports = {
    updateEntity
};