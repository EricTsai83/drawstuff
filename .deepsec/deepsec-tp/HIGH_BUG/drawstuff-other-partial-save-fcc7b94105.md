# [HIGH_BUG] Scene is committed before asset uploads are known to have succeeded

**File:** [`src/hooks/use-cloud-upload.ts`](https://github.com/EricTsai83/drawstuff/blob/main/src/hooks/use-cloud-upload.ts#L170-L292) (lines 170, 181, 223, 237, 265, 268, 274, 288, 292)
**Project:** drawstuff
**Severity:** HIGH_BUG  •  **Confidence:** high  •  **Slug:** `other-partial-save`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

uploadSceneToCloud calls saveSceneAction first, committing the scene data and revision, then uploads image assets afterward. If an asset upload throws, the hook returns false after the database scene has already been created or updated; if UploadThing returns an empty or partial result without throwing, Promise.all can resolve and the hook marks the scene clean/success. Because sceneData references file ids while the actual files are stored separately, this can leave a saved cloud scene revision with missing images and no rollback path.

## Recommendation

Make the save atomic from the user's perspective: upload assets to a pending/draft scope before committing sceneData, or have the server coordinate scene and asset records in one finalized operation. Verify each startUpload result count/key, and on any asset failure either roll back a newly-created scene/revert the update or keep the local scene dirty and surface a retryable failure.

## Revalidation

**Verdict:** true-positive

The core ordering is still present: uploadSceneToCloud calls saveSceneAction first, and saveOwnedScene commits sceneData and increments the revision before any image asset upload starts. The saved sceneData is produced from the current Excalidraw elements and can reference image file ids whose compressed file blobs are only uploaded afterward through sceneAssetUploader. The current working tree mitigates part of the original bug by checking that each startUpload result has length 1, by throwing from UploadThing on DB write failures, and by not calling syncCurrentScene until uploads finish. It also marks the local scene dirty on upload failure and attempts to delete the newly created scene when the failed save was a create. However, for an existing-scene update, the catch path does not revert sceneData or restore the previous revision; it only updateLastSyncedRevision(revision), marks dirty, reports an error, and returns false. That leaves the server's latest committed scene revision able to reference file ids without corresponding file records until a later retry succeeds. Remote loading paths fetch sceneData and file records separately and tolerate incomplete hydration, so another tab/device can observe a scene with missing images. The issue is therefore partially mitigated but still real for updates and for best-effort new-scene rollbacks that fail.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-04-13)
