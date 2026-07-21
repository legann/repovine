import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    component: UsersComponent,
    children: [
      { path: 'list', component: UserListComponent },
    ],
  },
];

@NgModule({ imports: [RouterModule.forChild(routes)] })
export class UsersModule {}
