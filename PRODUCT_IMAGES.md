# Product image uploads

The existing `Product.imageUrl` cover and ordered `Product.galleryUrls` fields are
reused. No Prisma migration or new dependency is required. Existing external URLs
and storefront paths stay unchanged. The product CSV importer currently imports
catalogue fields, not images; it neither downloads nor copies remote images.

## Configuration and deployment

Run the backend from `Backend/` with:

```dotenv
UPLOAD_DIR=./uploads
PUBLIC_API_URL=http://localhost:3001
```

`UPLOAD_DIR` is resolved against the process working directory; an absolute path
is also supported. It must be outside `src` and `dist`. Startup creates the
directory and its `products/` subdirectory. The default local `uploads/` directory
is ignored by Git. Keep any custom storage directory out of source control too.
The runtime user needs read/write/delete permissions there. Do not clean this
directory as part of a build or deployment.

`PUBLIC_API_URL` is the API's public **origin**: scheme, host and optional port,
without credentials, path, query or fragment. A trailing slash is accepted.
Locally, leaving it unset uses `http://localhost:<PORT>`. Production requires an
explicit HTTPS origin. URLs are never derived from an untrusted request Host.
Existing dashboard/storefront product JSON shapes are unchanged; their image
fields contain absolute URLs for uploaded images. Legacy references stay as stored.

For Render production, provision a persistent disk separately and mount it at,
for example, `/var/data`. Configure:

```dotenv
UPLOAD_DIR=/var/data/uploads
PUBLIC_API_URL=https://YOUR-API.onrender.com
```

Only files beneath the disk's mount path persist. Render's default filesystem is
temporary: uploads disappear on restart/redeploy without a persistent disk.
Free Render web services **cannot attach persistent disks**. This code does not
purchase a disk or change the service plan. See Render's
[persistent disk documentation](https://render.com/docs/disks) and
[free service limitations](https://render.com/docs/free).

Use one disk-backed service instance; independent local disks do not share files.
Render disks are available at runtime, not during build or pre-deploy commands.
Monitor disk space and back up the database and upload disk together. When moving
the service, copy the `products/` directory intact and preserve its stored keys.
Changing `PUBLIC_API_URL` then updates generated URLs without rewriting Prisma.

After deployment, upload an image, fetch its public URL, restart/redeploy the
service, and fetch the same URL again. Also verify deletion and cross-origin
rendering from both frontend origins. These are deployment checks to perform;
no Render restart/redeploy check was performed during implementation.

## Frontend contract

All management routes use `Authorization: Bearer <accessToken>`, require a live,
verified `ADMIN` or `STAFF` account, and use public product IDs such as `PRD-1001`.
There is no separate per-user product owner: both roles manage the catalogue.
Image ownership means membership in the specified product's cover/gallery.

| Method | Exact route | Result |
|---|---|---|
| GET | `/products/:productId/images` | `200 { data: ProductImage[] }` |
| POST | `/products/:productId/images` | `201 { data: ProductImage[], product: ProductDto }` |
| POST | `/products/:productId/images?replaceImageId=:imageId` | Same response; replaces one slot with exactly one uploaded file |
| DELETE | `/products/:productId/images/:imageId` | `200 { data: ProductImage[], product: ProductDto }` |
| PATCH | `/products/:productId` | Existing JSON edit route for selecting the cover/reordering; returns `ProductDto` |
| GET / HEAD | `/uploads/products/<uuid>.<jpg\|png\|webp>` | Public image bytes, no authentication |

`ProductImage` has exactly `{ id, url, isCover, position }`. `position` is zero-based
in display order. An uploaded image's ID is its UUID; an external/storefront
reference has a stable `ext-<sha256>` ID. Treat IDs as opaque and use those returned
by GET/POST, including when deleting an external reference. Metadata is derived
from the existing fields; there is no original-filename/alt/size metadata model to
migrate. Storefront alt text continues to come from the product name.

Upload uses multipart field **`images`**, repeated for each file, with no other
multipart fields. For example:

```js
const form = new FormData();
for (const file of selectedFiles) form.append('images', file);
const response = await fetch(`${apiUrl}/products/PRD-1001/images`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
  body: form,
});
const result = await response.json();
```

Let the browser set `Content-Type` and its boundary. For safe replacement, send
one file to the same route with `?replaceImageId=<id>`. This works even at eight
images and preserves that slot's position/cover status. Deletion has no body:

```http
DELETE /products/PRD-1001/images/12222535-c312-4aa1-8a11-65222c111111
Authorization: Bearer <accessToken>
```

Example POST response (DELETE and replacement use the same envelope):

```json
{
  "data": [
    {
      "id": "12222535-c312-4aa1-8a11-65222c111111",
      "url": "https://api.example.com/uploads/products/12222535-c312-4aa1-8a11-65222c111111.png",
      "isCover": true,
      "position": 0
    }
  ],
  "product": {
    "id": "PRD-1001",
    "name": "Ceramic Mug",
    "sku": "MUG-001",
    "subtitle": null,
    "description": null,
    "categoryId": "e777f77f-5678-4567-8234-56789abcdef0",
    "category": "Home & Kitchen",
    "brand": null,
    "imageUrl": "https://api.example.com/uploads/products/12222535-c312-4aa1-8a11-65222c111111.png",
    "galleryUrls": [],
    "status": "ACTIVE",
    "price": 12.5,
    "currency": "PKR",
    "costPrice": null,
    "margin": null,
    "stock": 10,
    "version": 2,
    "createdAt": "2026-10-15T10:00:00.000Z",
    "updatedAt": "2026-10-15T10:01:00.000Z"
  }
}
```

GET returns just the `data` portion. All mutations increment `product.version`
and record the existing image-change history event in the same transaction.
Refresh the editor's version from the mutation response before the next PATCH.

Uploads append in request order, preserving existing cover and gallery order.
For an empty product the first upload becomes the cover. If a legacy product has
gallery images but no cover, its first existing gallery image becomes the cover
on an image mutation. Deleting the cover promotes the next image; deleting the
last image leaves `imageUrl: null, galleryUrls: []`.

To select/reorder already owned images, use the existing edit endpoint:

```http
PATCH /products/PRD-1001
Authorization: Bearer <accessToken>
Content-Type: application/json

{"version":3,"imageUrl":"https://api.example.com/uploads/products/12222535-c312-4aa1-8a11-65222c111111.png","galleryUrls":[]}
```

`imageUrl` is the cover; `galleryUrls` contains only additional images, in order.
Omitted fields remain unchanged. `null` clears the cover; `[]` clears the gallery.
Removing references this way triggers cleanup after commit. Owned absolute upload
URLs round-trip to relative storage keys; uploads belonging to another product
cannot be attached through this route or product creation. External URL editing
continues to work. Create the product first, then upload files to its returned ID.

## Limits and errors

- JPEG, PNG and WebP only; actual signatures and container structure are checked.
  Filenames and submitted MIME types do not determine the stored extension.
  SVG, GIF, other unsupported formats, empty and structurally invalid files fail.
- Each file is at most **5 MiB (5,242,880 bytes)**. A request contains **1–8 files**
  and a product contains at most **8 images**, including existing URLs and cover.
  Concurrent writes are serialized with a PostgreSQL transaction advisory lock.
- Existing products above eight retain their images. Legacy URL edits may retain
  or reduce that count; uploads/additions cannot exceed the current limit.
- Uploads are throttled to 10/minute per the existing client tracker; at most two
  memory upload requests run per process. Multipart fields/counts/sizes are bounded.

Errors retain Nest conventions, for example:

```json
{"statusCode":400,"message":"A product can have at most 8 images","error":"Bad Request"}
```

`message` is a string for domain errors or a string array for DTO validation.

| Status | Meaning / representative message |
|---|---|
| 400 | `At least one image is required`; `Images must contain a valid JPEG, PNG, or WebP image`; count limit; unexpected multipart fields/files; invalid query/product ID |
| 400 | `Uploaded images must already belong to this product`; `Replacing an image requires exactly one file` |
| 401 | Missing/invalid/expired token or revoked session (existing authentication messages) |
| 403 | `Email verification required` or `Insufficient permissions` |
| 404 | `Product not found` for missing/archived products; `Image not found` for wrong-product/unknown image IDs |
| 409 | Existing stale-version message if an edit/stock/archive races with the image write; reload the product |
| 413 | Multer: `File too large`; service validation: `Each image must be 5 MB or smaller` |
| 429 | Existing throttle response or `Too many uploads in progress.` |
| 500 | Database/filesystem failure; generic internal-server response |

Public files have content types based on generated extensions, `nosniff`,
cross-origin resource permission and immutable caching. Only generated image
paths are served: no directory listing, arbitrary root files, or traversal paths.
Deleting a reference does not revoke copies already cached by clients.

## Consistency and recovery

Every batch is fully validated before disk writes. Files use server-generated UUID
names opened exclusively. All image reference changes and their history run in a
database transaction. A failed batch rolls back database changes and removes its
new files; partial disk writes are also removed. Replacement writes the new file,
links it, commits, then attempts to remove the old file.

Deletion removes the database reference first, then unlinks only if no product
still refers to that file. Archived products also count as references. Existing
external origins and storefront paths never become filesystem deletion targets.
Product deletion remains archival: its image references and files are retained.
There is no new hard-delete endpoint.

Cleanup failures are logged and retried in memory every ten minutes. Startup and
the same periodic recovery scan remove unreferenced generated files older than
24 hours, covering a process crash between disk writes and database commit, or
between commit and cleanup. Reference checks use the same database lock as image
writes. Unsupported files and filenames are never scanned for deletion.

This is best-effort recovery, not a distributed filesystem/database transaction.
After a restart, lost in-memory retries may wait until the file is 24 hours old.
Persistent database or disk failures require operator intervention; recovery does
not reconstruct lost/corrupted referenced files or remove cached client copies.
No queue or new background infrastructure is introduced.

## Verification

Repository commands: `npm test -- --runInBand`, `npm run test:e2e -- --runInBand`,
`npx tsc --noEmit`, `npm run lint`, `npm run build`. E2e tests require a migrated,
isolated PostgreSQL database ending in `_test` in `.env.test` and truncate its data.
The upload suite uses its own temporary filesystem directory and removes it at
teardown. Do not point tests at a development/production database.
