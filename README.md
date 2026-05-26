# 3D-kartan-backend

This is a simple backend server for 3D-kartan that handles address searching and 
forms management for the frontend.

The address search needs a PostgreSQL + PostGIS table to be set up, to search against it.

The forms store can be either fs (as a json-file) or pg. Pg is recommended for production.

Environment: the backend has been tested and works being deployed in an Microsoft server hosted via IIS.

---

## Set up the application

1. Clone the repo
2. CD app
3. `npm install`
4. Configure proper PostgreSQL + PostGIS setup (schema, tables and user)
5. Set the proper `.env` variables
6. If you wish to deply the service with auto start in an server environment. 
Set up a task, running the `.bat` script triggering `node server.js`
7. If you wish to skip auto start, then just run `node server.js` and the service will be up an running

The backend runs on `localhost:4001` and can be accesible by the frontend with proper cors in the .env and URL rewrites in IIS.

---

## Admin interface for forms management

The backend comes with three html sites one for forms creating, one for viewing forms submissions and one that handles the login. The admin interface is protected by a cookie-based basic encryption.

They are locally reached from:

- `localhost:4001/admin/forms.html`
- `localhost:4001/admin/submissions.html`
- `localhost:4001/admin/login.html`

or public (via URL Rewrite)

- `https://your-URL/admin/forms.html`
- `https://your-URL/admin/submissions.html`
- `https://your-URL/admin/login.html`

---

## Recommended requirements: 

- PostgreSQL + PostGIS (DB to store forms and sumbission and search addresses).
- Deployment on a Microsoft server with IIS.
- Good knowledge of DB, Microsoft server + IIS and the basics of coding.
- To have a PostgreSQL + PostGIS base set up, then you can take a look at the psql script - as a guide for how the backend is set up. You can create your own schema, tables and roles but then you have to change the code to match your set up.









