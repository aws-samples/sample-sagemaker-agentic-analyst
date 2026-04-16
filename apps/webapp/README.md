This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Run locally

```bash
# Install dependencies (run at monorepo root)
pnpm install --frozen-lockfile

# Set up environment variables
cp apps/webapp/.env.local.example apps/webapp/.env.local
# Populate values in apps/webapp/.env.local

# Start development servers (webapp + chat-agent)
./scripts/dev-server.sh start
```

Open [http://localhost:3012](http://localhost:3012) with your browser to see the result.

```bash
# Stop servers
./scripts/dev-server.sh stop

# Check status
./scripts/dev-server.sh status
```

## Project Structure

```
webapp/
├── src/
│   ├── app/             # App router pages and API routes
│   ├── components/      # React components
│   ├── lib/             # Utility functions and configurations
│   ├── stores/          # Zustand stores
│   └── proxy.ts         # Route protection (redirects unauthenticated users)
└── tests/               # Unit and integration tests
```

## How to expand the project

### Pages

To add new pages to the application:

1. Create a new directory under `src/app` with the desired route name
2. Add a `page.tsx` file inside this directory
3. For protected pages, place them under `src/app/(app)/` — route protection is handled by `proxy.ts`

### Server Actions

This project uses type-safe server actions with authentication:

1. Define input schemas in `src/actions/schemas`:

   ```typescript
   // src/actions/schemas/example.ts
   import { z } from 'zod';

   export const exampleActionSchema = z.object({
     field1: z.string().min(1, 'Field is required'),
     field2: z.number().optional(),
   });
   ```

2. Create server actions in `src/actions`:

   ```typescript
   // src/actions/example.ts
   'use server';

   import { authActionClient } from '@/lib/safe-action';
   import { exampleActionSchema } from './schemas/example';

   export const exampleAction = authActionClient.schema(exampleActionSchema).action(async ({ parsedInput, ctx }) => {
     const { field1, field2 } = parsedInput;
     const { userId } = ctx;

     // Perform database operations or other logic
     await db.insert(exampleTable).values({ field1, field2, userId });
     // Data is returned via SWR — call mutate() on the client after this action succeeds
   });
   ```

3. Use server actions in client components:

   a. With React Hook Form:

   ```tsx
   'use client';

   import { useHookFormAction } from '@next-safe-action/adapter-react-hook-form/hooks';
   import { zodResolver } from '@hookform/resolvers/zod';
   import { exampleAction } from '@/actions/example';
   import { exampleActionSchema } from '@/actions/schemas/example';
   import { toast } from 'sonner';
   import { handleError } from '@/lib/error-handler';

   export default function ExampleForm() {
     const {
       form: { register, formState },
       action,
       handleSubmitWithAction,
     } = useHookFormAction(exampleAction, zodResolver(exampleActionSchema), {
       actionProps: {
         onSuccess: () => {
           toast.success('Action completed successfully');
         },
         onError: ({ error }) => {
           handleError(error);
         },
       },
       formProps: {
         defaultValues: {
           field1: '',
           field2: 0,
         },
       },
     });

     return (
       <form onSubmit={handleSubmitWithAction}>
         {/* Form fields */}
         <input {...register('field1')} />
         {formState.errors.field1 && <p className="text-red-500">{formState.errors.field1.message}</p>}
         <button type="submit" disabled={action.isExecuting}>
           {action.isExecuting ? 'Submitting...' : 'Submit'}
         </button>
       </form>
     );
   }
   ```

   b. For simple actions without forms:

   ```tsx
   'use client';

   import { useAction } from 'next-safe-action/hooks';
   import { simpleAction } from '@/actions/example';
   import { toast } from 'sonner';
   import { handleError } from '@/lib/error-handler';

   export default function ExampleButton() {
     const { execute, status } = useAction(simpleAction, {
       onSuccess: () => {
         toast.success('Action completed successfully');
       },
       onError: (error) => {
         handleError(error);
       },
     });

     return (
       <button onClick={() => execute({ id: '123' })} disabled={status === 'executing'}>
         {status === 'executing' ? 'Processing...' : 'Execute Action'}
       </button>
     );
   }
   ```
